"""KOS producer — 邮件 → Jarvis KOS v2 page payload + 推送 (Scenario B)。

对齐 docs/MAILAGENT-INGEST-HANDOFF.md §4 (Lucien 2026-05-26 更新):
    slug    = 'sources/email/{internal_id}'
    content = YAML frontmatter (type:email, status:stable, date_received,
              sender/recipient/cc/mailbox/thread_id, source_refs,
              mailagent: 嵌套含回写的 AI labels) + markdown body
              (subject H1 + metadata blockquote + 正文 + AI 分析 + 附件清单)

**Source 路由靠 OAuth client 身份, 不是 put_page 参数** (Lucien 2026-05-26):
bulk client (MAILAGENT_BULK_CLIENT_*) 绑 mailagent-emails isolated source。
用 ``make_bulk_kos_client()`` 拿的 client put_page **不传 source**, page 自动
归 mailagent-emails。frontmatter 里仍带 ``source: mailagent-emails`` 作 logical
tag (doc §4)。原 KOS_OAUTH_CLIENT_* 绑 default (chat-save + consumer query)。

两条消费路径共享 ``build_kos_page_payload``:
- 增量 (new_watcher hook): ``push_email_to_kos(email_obj, ...)`` — 带 priority
  floor 过滤, fire-and-forget。
- bulk 历史回填 (mailagent kos ingest / src/kos/bulk_ingest.py): 直接调
  ``build_kos_page_payload`` + bulk client put_page, 不过滤 (全量入)。
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Optional

from loguru import logger

from src.kos.client import KOSClient, KOSError
from src.models import Email

# 整页 content 字节上限 (doc §7: KOS 50KB content-sanity warn; 留 1KB buffer)。
# 按字节而非字符 — 中文 UTF-8 每字 3 字节, 字符截断会让中文邮件远超 50KB。
_PAGE_CAP_BYTES = 49000

# Priority hierarchy (low → high). Index 越大优先级越高。
_PRIORITY_ORDER: list[str] = ["low", "normal", "important", "urgent", "critical"]

# LLM agent 输出的中文 priority enum → 英文 normalize。
_CN_PRIORITY_MAP: dict[str, str] = {
    "🔴 紧急": "critical",
    "🟡 重要": "important",
    "🟢 一般": "normal",
    "⚪ 低": "low",
}


def _normalize_priority(raw: Optional[str]) -> str:
    """中文 emoji enum / 英文 enum / unknown → 英文 5 档之一 (缺省 normal)。"""
    if not raw:
        return "normal"
    s = raw.strip()
    if s in _CN_PRIORITY_MAP:
        return _CN_PRIORITY_MAP[s]
    lower = s.lower()
    if lower in _PRIORITY_ORDER:
        return lower
    return "normal"


def normalize_message_id_for_slug(message_id: str) -> str:
    """RFC 2822 Message-ID → safe slug part。

    '<abc.123@host.com>' → 'abc-123-host-com'。保留作 backward-compat helper;
    Scenario B slug 现在用 internal_id (见 build_kos_page_payload)。
    """
    if not message_id:
        return "unknown"
    s = message_id.strip().lstrip("<").rstrip(">").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "unknown"


def priority_at_or_above(actual: Optional[str], floor: str) -> bool:
    """检查 actual priority 是否 ≥ floor (增量 hook 过滤用)。

    ⚠️ ``actual=None`` (AI 从未标注) 在这里等价于 ``normal`` —— 这是历史语义,
    不改 (改返回值会波及所有调用点且不向后兼容)。要区分「未标注」第三态请用
    ``passes_priority_gate(..., require_labeled=True)``。
    """
    a = _normalize_priority(actual)
    f = _normalize_priority(floor) if floor else "normal"
    return _PRIORITY_ORDER.index(a) >= _PRIORITY_ORDER.index(f)


def is_labeled(actual: Optional[str]) -> bool:
    """AI 是否真的标注过优先级 —— 空/None/纯空白 = 未标注 (issue #49)。"""
    return bool(actual and str(actual).strip())


def passes_priority_gate(
    actual: Optional[str], floor: str, require_labeled: bool = False
) -> bool:
    """priority floor 过滤 + 「未标注」第三态 gate (issue #49)。

    ``priority_at_or_above`` 把「AI 从未标注」和「AI 判定 normal」当成同一件事,
    于是 ``--priority-floor normal`` 会把从未跑过 LLM 的历史邮件全部当 normal
    放行 (提 issue 者本地: 6042 未分类 vs 707 已分类达标, 未分类占 89%), 把大量
    没被处理过的脏全文塞进本该只收「AI 已确认重要」内容的知识库。

    ``require_labeled=True`` 时未标注直接挡掉, 不落 floor 的默认放行分支。默认
    False = 现状行为逐字节不变 (向后兼容)。增量 producer 与 bulk_ingest 两处
    过滤点共用本函数, 保证语义单源。
    """
    if require_labeled and not is_labeled(actual):
        return False
    return priority_at_or_above(actual, floor)


def _yaml_quote(s: Optional[str]) -> str:
    """YAML 单引号 quote (单引号自身 → 重复两次 escape)。"""
    if s is None:
        return "''"
    return "'" + str(s).replace("'", "''") + "'"


def _split_addrs(raw: Optional[str]) -> list[str]:
    """'a@x.com, b@y.com; c@z.com' → ['a@x.com', 'b@y.com', 'c@z.com']。"""
    if not raw:
        return []
    return [a.strip() for a in raw.replace(";", ",").split(",") if a.strip()]


def make_bulk_kos_client() -> KOSClient:
    """Scenario B bulk client — 绑 mailagent-emails isolated source。

    源路由靠 OAuth client 身份 (Lucien 2026-05-26): 这个 client 拿的 token
    put_page (不传 source) 自动归 mailagent-emails source。凭据从
    MAILAGENT_BULK_CLIENT_ID / MAILAGENT_BULK_CLIENT_SECRET env 读。
    """
    return KOSClient(
        client_id=os.getenv("MAILAGENT_BULK_CLIENT_ID"),
        client_secret=os.getenv("MAILAGENT_BULK_CLIENT_SECRET"),
    )


def build_kos_page_payload(
    *,
    internal_id: int,
    subject: str,
    sender: str,
    date_iso: str,
    mailbox: str,
    message_id: Optional[str] = None,
    sender_name: Optional[str] = None,
    to_addr: str = "",
    cc_addr: str = "",
    thread_id: Optional[str] = None,
    body_markdown: Optional[str] = None,
    labels: Optional[dict[str, Any]] = None,
    attachments: Optional[list[dict[str, Any]]] = None,
    notion_page_id: Optional[str] = None,
) -> tuple[str, str]:
    """构造 (slug, content) 给 KOS bulk put_page (doc §4 Scenario B 形状)。

    Args:
        internal_id: SQLite ROWID — slug 主键 + source_ref。
        subject/sender/date_iso/mailbox: 必备 metadata。
        message_id/sender_name/to_addr/cc_addr/thread_id: 可选 metadata。
        body_markdown: 邮件正文 markdown (EmailRepository.get_body_markdown);
            超 _MAX_BODY_CHARS 截断 + marker。
        labels: 完整 AI labels dict (llm_processing.labels_json — priority/
            action_type/category/ai_summary/key_points/sender_priority/language
            等)。进 frontmatter mailagent: 嵌套 + body "## AI 分析" 区块。
        attachments: [{filename, size, content_type}] — 进 "## Attachments"。
        notion_page_id: Notion mirror — 进 source_refs。

    Returns:
        (slug, content)。slug='sources/email/{internal_id}'。
    """
    labels = labels or {}
    slug = f"sources/email/{internal_id}"
    subject = (subject or "(no subject)").strip() or "(no subject)"
    date_only = (date_iso or "")[:10]
    cc_list = _split_addrs(cc_addr)

    ai_priority = labels.get("priority")
    ai_action = labels.get("action_type")
    ai_category = labels.get("category")
    ai_sender_priority = labels.get("sender_priority")
    ai_language = labels.get("language")

    # ---- frontmatter (doc §4) ----
    fm: list[str] = [
        "---",
        "type: email",
        "kind: source",
        f"title: {_yaml_quote(subject[:200])}",
        "status: stable",
        f"created: {_yaml_quote(date_only)}",
        f"updated: {_yaml_quote(date_only)}",
        f"date_received: {_yaml_quote(date_iso)}",
        f"sender: {_yaml_quote(sender)}",
    ]
    if sender_name:
        fm.append(f"sender_name: {_yaml_quote(sender_name)}")
    if to_addr:
        fm.append(f"recipient: {_yaml_quote(to_addr)}")
    if cc_list:
        fm.append("cc: [" + ", ".join(_yaml_quote(c) for c in cc_list) + "]")
    fm.append(f"mailbox: {_yaml_quote(mailbox)}")
    if thread_id:
        fm.append(f"thread_id: {_yaml_quote(thread_id)}")
    fm.append("tags: [email, mailagent-ingest, bulk]")
    fm.append("source: mailagent-emails")
    fm.append("source_of_truth: mailagent-sqlite")
    fm.append("source_refs:")
    fm.append(f"  - 'mailagent:{internal_id}'")
    if notion_page_id:
        fm.append(f"  - 'https://www.notion.so/{notion_page_id.replace('-', '')}'")
    # mailagent: 嵌套 — traceback IDs + 回写的 AI labels
    fm.append("mailagent:")
    fm.append(f"  email_id: {internal_id}")
    if message_id:
        fm.append(f"  message_id: {_yaml_quote(message_id)}")
    if thread_id:
        fm.append(f"  thread_id: {_yaml_quote(thread_id)}")
    if ai_priority:
        fm.append(f"  ai_priority: {_yaml_quote(ai_priority)}")
    if ai_action:
        fm.append(f"  ai_action: {_yaml_quote(ai_action)}")
    if ai_category:
        fm.append(f"  ai_category: {_yaml_quote(ai_category)}")
    if ai_sender_priority:
        fm.append(f"  ai_sender_priority: {_yaml_quote(ai_sender_priority)}")
    if ai_language:
        fm.append(f"  ai_language: {_yaml_quote(ai_language)}")
    fm.append("---")
    frontmatter = "\n".join(fm)

    # ---- body ----
    # issue #48: meta_block 不重复写 To/CC —— frontmatter 的 recipient/cc 已完整
    # 覆盖 (可回溯查询), body 里再拼一遍的代价是: 企业群发的长收件人名单会被切成
    # 独立 chunk 进 embedding, 语义检索时压过正文真正有价值的结论段落 (实测 top-1
    # 命中「收件人名单」而非「【结论】不可发布」)。附带收益: skeleton 变小,
    # 正文截断预算变大。
    meta_block = (
        f"> Ingested via mailagent kos push on {date_only}.\n"
        f"> From: {sender}\n"
        f"> Date: {date_iso}\n"
        f"> Mailbox: {mailbox}"
    )
    parts: list[str] = [f"# {subject}", "", meta_block, ""]
    body_idx = len(parts)
    parts.append("")  # body 占位, 最后按字节预算截入

    # AI 分析区块 — 给 KOS embedding / entity 抽取提供语义浓缩
    ai_summary = (labels.get("ai_summary") or "").strip()
    key_points = (labels.get("key_points") or "").strip()
    if ai_summary or key_points or ai_priority or ai_category:
        parts.extend(["", "## AI 分析", ""])
        if ai_summary:
            parts.extend([f"**摘要**: {ai_summary}", ""])
        if key_points:
            parts.extend(["**要点**:", "", key_points, ""])
        meta_bits = []
        if ai_category:
            meta_bits.append(f"分类: {ai_category}")
        if ai_priority:
            meta_bits.append(f"优先级: {ai_priority}")
        if ai_action:
            meta_bits.append(f"动作: {ai_action}")
        if ai_sender_priority:
            meta_bits.append(f"发件人: {ai_sender_priority}")
        if meta_bits:
            parts.append(" | ".join(meta_bits))

    # 附件清单 (仅文件名/大小/类型, 不含二进制; 附件正文另走 attachment FTS)
    if attachments:
        parts.extend(["", "## Attachments", ""])
        for a in attachments:
            name = a.get("filename", "?")
            size_mb = (a.get("size") or 0) / 1024 / 1024
            ct = a.get("content_type", "")
            parts.append(f"- {name} ({size_mb:.2f} MB, {ct})")

    # body 按字节截断, 保证整页 content < _PAGE_CAP_BYTES。body_budget = 整页上限
    # 减去 frontmatter + header + AI + 附件 的开销 (body 占位为空时的骨架字节)。
    body = (body_markdown or "").strip() or "_(body not extracted)_"
    marker = (
        f"\n\n> _(truncated to 50KB by mailagent client; "
        f"full body at mailagent:{internal_id})_"
    )
    skeleton_bytes = len((frontmatter + "\n\n" + "\n".join(parts)).encode("utf-8"))
    # -8 buffer: 结尾 "\n" (1) + decode(errors=ignore) 多字节边界余量
    body_budget = _PAGE_CAP_BYTES - skeleton_bytes - len(marker.encode("utf-8")) - 8
    body_bytes = body.encode("utf-8")
    if len(body_bytes) > body_budget > 0:
        body = body_bytes[:body_budget].decode("utf-8", errors="ignore") + marker
    parts[body_idx] = body

    content = frontmatter + "\n\n" + "\n".join(parts) + "\n"
    return slug, content


async def push_email_to_kos(
    email_obj: Email,
    internal_id: int,
    *,
    body_markdown: Optional[str] = None,
    notion_page_id: Optional[str] = None,
    ai_priority: Optional[str] = None,
    ai_action: Optional[str] = None,
    labels: Optional[dict[str, Any]] = None,
    attachments: Optional[list[dict[str, Any]]] = None,
    client: Optional[KOSClient] = None,
    priority_floor: str = "normal",
    require_labeled: bool = False,
    dry_run: bool = False,
) -> Optional[dict]:
    """增量推单封邮件到 KOS mailagent-emails source。Skip 返 None; success 返 dict。

    Skip cases (返 None, 不视为错):
        - ai_priority < priority_floor (增量过滤; bulk 路径不走这里)
        - require_labeled=True 且 AI 从未标注优先级 (issue #49)
        - bulk client 未 configured (MAILAGENT_BULK_CLIENT_* env 缺)
    Failure (返 None + warning): KOSError / 其他 exception (fire-and-forget)。
    """
    # labels 合并: caller 传完整 labels 优先; 否则用散的 ai_priority/ai_action
    merged: dict[str, Any] = dict(labels or {})
    if ai_priority and not merged.get("priority"):
        merged["priority"] = ai_priority
    if ai_action and not merged.get("action_type"):
        merged["action_type"] = ai_action

    effective_priority = merged.get("priority") or ai_priority
    if not passes_priority_gate(effective_priority, priority_floor, require_labeled):
        reason = (
            "unlabeled"
            if require_labeled and not is_labeled(effective_priority)
            else f"< floor={priority_floor!r}"
        )
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            f"priority={effective_priority!r} {reason}"
        )
        return None

    if client is None:
        client = make_bulk_kos_client()
    if not client.configured:
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            "bulk KOSClient not configured (MAILAGENT_BULK_CLIENT_* missing)"
        )
        return None

    slug, content = build_kos_page_payload(
        internal_id=internal_id,
        subject=email_obj.subject,
        sender=email_obj.sender,
        date_iso=email_obj.date.isoformat() if email_obj.date else "",
        mailbox=email_obj.mailbox,
        message_id=email_obj.message_id,
        sender_name=email_obj.sender_name,
        to_addr=email_obj.to,
        cc_addr=email_obj.cc,
        thread_id=email_obj.thread_id,
        body_markdown=body_markdown,
        labels=merged,
        attachments=attachments,
        notion_page_id=notion_page_id,
    )

    if dry_run:
        logger.info(
            f"[kos-producer] dry-run internal_id={internal_id} "
            f"slug={slug} content_bytes={len(content.encode('utf-8'))}"
        )
        return {
            "dry_run": True,
            "slug": slug,
            "content_bytes": len(content.encode("utf-8")),
        }

    try:
        result = await asyncio.to_thread(client.put_page, slug, content)
        status = result.get("status") if isinstance(result, dict) else "?"
        logger.info(
            f"[kos-producer] pushed internal_id={internal_id} slug={slug} status={status}"
        )
        return result
    except KOSError as e:
        logger.warning(
            f"[kos-producer] push failed internal_id={internal_id} "
            f"slug={slug} code={e.code} msg={e}"
        )
        return None
    except Exception as e:
        logger.warning(
            f"[kos-producer] unexpected error internal_id={internal_id} slug={slug}: {e}"
        )
        return None
