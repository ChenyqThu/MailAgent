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
- bulk 历史回填 (``python -m src.kos.bulk_ingest``): 直接调
  ``build_kos_page_payload`` + bulk client put_page。过滤在 ``run()`` 层做
  (priority floor + require-labeled gate), payload builder 本身不负责过滤。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger

from src.kos import ingest_log
from src.kos.client import KOSClient, KOSError
from src.models import Email

# 整页 content 字节上限 (doc §7: KOS 50KB content-sanity warn; 留 1KB buffer)。
# 按字节而非字符 — 中文 UTF-8 每字 3 字节, 字符截断会让中文邮件远超 50KB。
_PAGE_CAP_BYTES = 49000

# ---- 分区上限 (codex review MEDIUM-3) --------------------------------------
# 原实现只给 body 做预算, 其余区块**全部无界**: cc 名单 (企业群发可达数千个地址)、
# ai_summary / key_points (LLM 想写多长写多长)、附件清单 (条数 × 文件名长度) 都能
# 单独把 49KB 吃光。吃光之后 body_budget <= 0, 而截断判据 `> body_budget > 0` 的
# 链式比较此时整体为 False → **完全不截, 完整正文照塞** —— 越是该截的场景越不截。
#
# 所以每个无界区块各自设上限, 让 skeleton 有确定的上界 (~33KB), body 恒有预算;
# 末尾再加一道整页兜底截断防漏。
_FM_CC_MAX = 200  # frontmatter cc 条目上限
_FM_ADDR_CAP_BYTES = 4000  # frontmatter 单个地址字段 (recipient) 字节上限
_AI_TEXT_CAP_BYTES = 6000  # ai_summary / key_points **各自**的字节上限
_ATT_LIST_MAX = 50  # 附件清单条目上限
_ATT_NAME_MAX = 180  # 单条文件名字符上限


def _truncate_bytes(text: str, cap: int, marker: str = "…[truncated]") -> str:
    """按 UTF-8 字节截断, 多字节边界处用 errors='ignore' 丢掉半个字符。"""
    raw = text.encode("utf-8")
    if len(raw) <= cap:
        return text
    return raw[:cap].decode("utf-8", errors="ignore") + marker

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


#: ``priority_label_state`` 的三种取值。
LABEL_MISSING = "missing"  # 空/None/纯空白 —— AI 从没标注过
LABEL_UNKNOWN = "unknown"  # 有值但不在枚举里 —— 人工/外部写入的野值
LABEL_KNOWN = "known"  # 认识的 5 档之一


def priority_label_state(actual: Optional[str]) -> str:
    """把 priority 的「标注状态」分成三态 (issue #49 + codex review MEDIUM-2)。

    🔴 为什么 unknown 要跟 missing 分开、又都不算「已标注」:
    ``_normalize_priority`` 把不认识的值也降成 ``normal``, 所以 ``"foo"`` 这种野值
    (Notion 人工字段 / 自定义 agent / ``upsert_external_labels`` 写入, store 层不校验
    枚举) 在 floor=normal 下同样会被放行 —— 跟 #49 抱怨的「未标注被当 normal」是**同
    一类 bug**。所以 ``require_labeled`` 下两者都挡。

    但计数上必须分开: 把两种状态合成一个数字, 正是 #49 的病根。运维看到
    ``skipped_invalid_priority`` 才知道要去查是谁写了野值。
    """
    if not actual or not str(actual).strip():
        return LABEL_MISSING
    s = str(actual).strip()
    if s in _CN_PRIORITY_MAP or s.lower() in _PRIORITY_ORDER:
        return LABEL_KNOWN
    return LABEL_UNKNOWN


def is_labeled(actual: Optional[str]) -> bool:
    """AI 是否**有效**标注过优先级 —— 只有能落到已知枚举才算 (issue #49)。"""
    return priority_label_state(actual) == LABEL_KNOWN


def passes_priority_gate(
    actual: Optional[str], floor: str, require_labeled: bool = False
) -> bool:
    """priority floor 过滤 + 「未标注」第三态 gate (issue #49)。

    ``priority_at_or_above`` 把「AI 从未标注」和「AI 判定 normal」当成同一件事,
    于是 ``--priority-floor normal`` 会把从未跑过 LLM 的历史邮件全部当 normal
    放行 (提 issue 者本地: 6042 未分类 vs 707 已分类达标, 未分类占 89%), 把大量
    没被处理过的脏全文塞进本该只收「AI 已确认重要」内容的知识库。

    ``require_labeled=True`` 时未标注直接挡掉, 不落 floor 的默认放行分支。默认
    False = 放行/阻断语义与改动前完全一致 (向后兼容)。注意口径: 等价的是**过滤判定**,
    不是输出字节 —— bulk 的 stats dict 多了 skipped_unlabeled / skipped_invalid_priority
    两个计数键、日志多了 require_labeled 字段 (codex review LOW-2)。增量 producer 与 bulk_ingest 两处
    过滤点共用本函数, 保证语义单源。
    """
    if require_labeled and not is_labeled(actual):
        return False
    return priority_at_or_above(actual, floor)


def _yaml_quote(s: Optional[str]) -> str:
    """YAML 单引号 quote (单引号自身 → 重复两次 escape; 换行/制表符先归一成空格)。

    🔴 归一先于转义: 本函数拼出的是**单行** frontmatter 字段 (``f"title: {...}"``
    这类, 靠 ``"\\n".join(fm)`` 拼行), 值里若带裸换行会把这一行从中间断成多行 ——
    若断出来的某一行恰好长得像 ``---`` (YAML 文档分隔符), ``yaml.safe_load`` 直接
    ``ScannerError``、整页 frontmatter 解析报废 (交叉 review 发现: subject 完全由
    发件人控制、从未做换行归一; 全保留路线落地后 ai_category/sender_priority 等
    自由文本字段同样无长度/内容约束, 风险面更大)。

    只收窄到换行类空白 (``\\t`` ``\\n`` ``\\r`` 及竖式制表/换页), 不动普通空格/
    全角空格 —— 不含这些字符的普通值转义前后逐字节不变。放在这一个函数里做,
    是因为它是所有 frontmatter 字段唯一共享的出口, 单点修复全调用点受益。
    """
    if s is None:
        return "''"
    text = re.sub(r"[\t\n\r\x0b\x0c]+", " ", str(s))
    return "'" + text.replace("'", "''") + "'"


def _split_addrs(raw: Optional[str]) -> list[str]:
    """'a@x.com, b@y.com; c@z.com' → ['a@x.com', 'b@y.com', 'c@z.com']。"""
    if not raw:
        return []
    return [a.strip() for a in raw.replace(";", ",").split(",") if a.strip()]


# ---- Thread 链接 (KOS 每日 sweep 抽 markdown 链接成图谱边) ---------------------
# root-relative + `.md` 后缀 + markdown 链接形式, 精确 `sources/email/{internal_id}.md`。
_THREAD_LINK_TEXT_MAX = 120


def _sanitize_link_text(subject: Optional[str]) -> str:
    """subject → markdown 链接文本, 防破链: `[`→`(`、`]`→`)`、换行/多空格压单空格、
    截 120 字符, 空 → '(no subject)'。"""
    s = (subject or "").replace("[", "(").replace("]", ")")
    s = " ".join(s.split())  # 换行 + 连续空白压成单空格 (markdown 链接文本不能换行)
    s = s[:_THREAD_LINK_TEXT_MAX]
    return s or "(no subject)"


def resolve_thread_refs(db_path: str, internal_id: int) -> dict[str, Optional[tuple[int, str]]]:
    """反查 direct parent (In-Reply-To) 与 thread root (References[0]) 的 (internal_id,
    subject), 供 ``build_kos_page_payload`` 的 ``## Thread`` 节生成链接。

    读本封行的 in_reply_to / thread_id, 各自经 message_id 等值反查 email_metadata
    (存储均无尖括号)。guard:
      - parent/root 反查命中自身 internal_id → None (线程首封: davmail thread_id==自身)
      - root == parent → root 置 None (一层回复只出 In reply to 行, 避免重复)
      - 反查 miss (pre-history / 未同步) → None (slug 需要 internal_id, 构造不出目标)

    增量 (new_watcher hook) 与 bulk_ingest 两条路径共用本反查 → 同一封邮件两路径
    payload 一致。KOS 是图谱丰富层不是功能数据: 任何异常吞掉返回空, 绝不炸主流程。
    裸 sqlite3 只读连接 (timeout=30, 同 bulk_ingest._get_labels 风格)。
    """
    empty: dict[str, Optional[tuple[int, str]]] = {"parent": None, "root": None}
    try:
        conn = sqlite3.connect(db_path, timeout=30)
        try:
            row = conn.execute(
                "SELECT in_reply_to, thread_id FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if row is None:
                return empty
            in_reply_to, thread_id = row[0], row[1]

            def _lookup(msg_id: Optional[str]) -> Optional[tuple[int, str]]:
                if not msg_id:
                    return None
                r = conn.execute(
                    "SELECT internal_id, subject FROM email_metadata WHERE message_id = ?",
                    (msg_id,),
                ).fetchone()
                if r is None or int(r[0]) == internal_id:
                    return None
                return (int(r[0]), r[1] or "")

            parent = _lookup(in_reply_to)
            root = _lookup(thread_id)
            # 一层回复: root == parent → 只保留 In reply to 行 (避免重复行)。
            if parent is not None and root is not None and root[0] == parent[0]:
                root = None
            return {"parent": parent, "root": root}
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — KOS 丰富层, 反查失败绝不阻断主流程
        return empty


def _build_thread_section(
    thread_parent: Optional[tuple[int, str]],
    thread_root: Optional[tuple[int, str]],
) -> list[str]:
    """构造 ``## Thread`` 节 markdown 行 (含前后空行), 两者皆无 → []。"""
    lines: list[str] = []
    if thread_parent is not None:
        pid, psubj = thread_parent[0], thread_parent[1]
        lines.append(f"- In reply to: [{_sanitize_link_text(psubj)}](sources/email/{pid}.md)")
    if thread_root is not None:
        rid, rsubj = thread_root[0], thread_root[1]
        lines.append(f"- Thread root: [{_sanitize_link_text(rsubj)}](sources/email/{rid}.md)")
    if not lines:
        return []
    return ["## Thread", "", *lines, ""]


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
    thread_parent: Optional[tuple[int, str]] = None,
    thread_root: Optional[tuple[int, str]] = None,
    in_reply_to_email_id: Optional[int] = None,
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
        thread_parent: (internal_id, subject) of direct parent (In-Reply-To)。非 None
            时 body 加 ``## Thread`` 节的 "In reply to" 行 (链接 sources/email/{id}.md)。
        thread_root: (internal_id, subject) of thread root (References[0])。非 None
            时加 "Thread root" 行。二者皆 None → 整节不出 (线程首封)。由 resolve_thread_refs
            反查, 两条消费路径 (增量 hook / bulk_ingest) 共用。
        in_reply_to_email_id: provenance — frontmatter mailagent: 嵌套加 in_reply_to_email_id。
            None 且 thread_parent 非 None 时从 thread_parent[0] 派生。

    ``## Thread`` 节插在 meta_block 之后、body 占位之前 → 天然进 skeleton_bytes →
    body 预算相应缩小 → **永不被截** (handoff 硬约束「treat it like metadata」)。

    整页恒 ≤ ``_PAGE_CAP_BYTES``。**超限时截谁**, 按「每字节语义价值」从低到高砍
    (codex review MEDIUM-3 之前只有 body 有预算, 其余区块无界)::

        1. 附件清单   —— 条数 _ATT_LIST_MAX + 文件名 _ATT_NAME_MAX。文件名不承载
                        结论, entity 抽取也拿不到东西, 每字节价值最低。
        2. AI 分析区  —— ai_summary / key_points 各 _AI_TEXT_CAP_BYTES。LLM 输出
                        无长度约束, 但前几百字节就把摘要说完了。
        3. 正文       —— 拿走剩余全部预算, 超出部分截断 + marker 指回 SQLite 原文。
        4. frontmatter —— **绝不截**。它是 YAML, 截断 = 整页解析失败, 连 metadata
                        都丢。所以它内部的无界字段 (recipient / cc) 自己有界,
                        cc 被砍时写 ``cc_truncated: N`` 留痕。

    末尾还有一道整页兜底硬截 (从尾部砍, frontmatter 在头部恒完整), 防某个区块的
    上限算漏了导致整页超限被 KOS content-sanity 拒收。

    Returns:
        (slug, content)。slug='sources/email/{internal_id}'。
    """
    labels = labels or {}
    slug = f"sources/email/{internal_id}"
    subject = (subject or "(no subject)").strip() or "(no subject)"
    date_only = (date_iso or "")[:10]
    cc_list = _split_addrs(cc_addr)
    # provenance: 未显式传则从 direct parent 派生 (二选一, 实现取简)。
    if in_reply_to_email_id is None and thread_parent is not None:
        in_reply_to_email_id = thread_parent[0]

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
        # frontmatter 是唯一**绝不截**的区块 (截了 YAML 就废, 整页解析失败), 所以
        # 它内部的无界字段必须自己有界 —— 企业群发的 To/CC 能到几千个地址。
        fm.append(f"recipient: {_yaml_quote(_truncate_bytes(to_addr, _FM_ADDR_CAP_BYTES))}")
    if cc_list:
        cc_shown = cc_list[:_FM_CC_MAX]
        fm.append("cc: [" + ", ".join(_yaml_quote(c) for c in cc_shown) + "]")
        if len(cc_list) > len(cc_shown):
            # 显式记录被砍掉多少 —— 静默截断会让「这封信到底抄送了谁」查不出来。
            fm.append(f"cc_truncated: {len(cc_list) - len(cc_shown)}")
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
    if in_reply_to_email_id is not None:
        fm.append(f"  in_reply_to_email_id: {in_reply_to_email_id}")
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
    # ## Thread 节 (metadata blockquote 之后) — 插在 body 占位之前 → 进 skeleton,
    # body 预算相应缩小, 永不被截 (handoff「treat it like metadata」)。KOS 每日 sweep
    # 抽这两个 markdown 链接成图谱边; parent/root 只两行, 不出 sibling 列表。
    parts.extend(_build_thread_section(thread_parent, thread_root))
    body_idx = len(parts)
    parts.append("")  # body 占位, 最后按字节预算截入

    # AI 分析区块 — 给 KOS embedding / entity 抽取提供语义浓缩
    # LLM 输出无长度约束, 各自设上限 (整页预算的第二优先级牺牲品, 见文件头分区上限)。
    ai_summary = _truncate_bytes((labels.get("ai_summary") or "").strip(), _AI_TEXT_CAP_BYTES)
    key_points = _truncate_bytes((labels.get("key_points") or "").strip(), _AI_TEXT_CAP_BYTES)
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
        # 条数 × 文件名长度都无界 —— 整页预算的**第一**牺牲品 (文件名的每字节语义
        # 价值最低: 它不承载结论, entity 抽取也拿不到什么)。
        for a in attachments[:_ATT_LIST_MAX]:
            name = str(a.get("filename", "?"))[:_ATT_NAME_MAX]
            size_mb = (a.get("size") or 0) / 1024 / 1024
            ct = a.get("content_type", "")
            parts.append(f"- {name} ({size_mb:.2f} MB, {ct})")
        if len(attachments) > _ATT_LIST_MAX:
            parts.append(f"- _(另有 {len(attachments) - _ATT_LIST_MAX} 个附件未列出)_")

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
    if body_budget <= 0:
        # skeleton 自己就吃满了预算, 正文一个字节都放不下。
        # 🔴 原实现这里写的是 `if len(body_bytes) > body_budget > 0:` —— 链式比较在
        # body_budget <= 0 时整体为 False, 于是**完全不截, 完整正文照塞**, 越是该截
        # 的场景越不截 (codex review MEDIUM-3)。分区上限落地后这条路径理论上不可达,
        # 保留作显式兜底。
        body = marker.strip()
    elif len(body_bytes) > body_budget:
        body = body_bytes[:body_budget].decode("utf-8", errors="ignore") + marker
    parts[body_idx] = body

    content = frontmatter + "\n\n" + "\n".join(parts) + "\n"
    # 整页兜底: 上面每个区块都各自有界, 这里是「算漏了」时的最后一道闸 —— 宁可尾部
    # 被砍掉一截 markdown, 也不要整页超限被 KOS content-sanity 拒收 (client.py 的
    # tool-level error 会让这次 put 变成 KOSError, 整封邮件入不了库)。
    # 从尾部砍: frontmatter 在头部, 永远完整, YAML 不会被破坏。
    raw = content.encode("utf-8")
    if len(raw) > _PAGE_CAP_BYTES:
        logger.warning(
            f"[kos-producer] internal_id={internal_id} 分区上限后整页仍超限 "
            f"({len(raw)} > {_PAGE_CAP_BYTES}), 尾部硬截 —— 说明某个区块的上限算漏了"
        )
        content = raw[:_PAGE_CAP_BYTES].decode("utf-8", errors="ignore")
    return slug, content


@dataclass
class KosPushOutcome:
    """``push_email_to_kos`` / ``repush_stored_email_to_kos`` 的三态返回值 (issue #59)。

    老签名 skip 与 failure 都返 ``None``, 调用侧 (new_watcher kos hook) 结构性
    无法区分「被 priority floor 过滤」与「推送失败」—— 101 页空洞在日志层面伪装成
    正常跳过, 只能事后人工核对才发现。三态化后调用侧失败记 warning、跳过维持 debug。

    status: 'pushed' | 'skipped' | 'failed' (与 kos_ingest_log.status 对齐;
        dry-run 归 'skipped', reason='dry_run')
    reason: skip 原因 ('priority_floor' | 'unlabeled' | 'not_configured' | 'dry_run')
    error_code / error: 失败时的 KOSError.code (非 KOSError → 'E_KOS_UNEXPECTED') 与消息
    result: 成功时 put_page 服务端返回; dry-run 时 {'dry_run': True, 'slug', 'content_bytes'}
    """

    status: str
    reason: Optional[str] = None
    error_code: Optional[str] = None
    error: Optional[str] = None
    result: Optional[dict[str, Any]] = None

    @property
    def pushed(self) -> bool:
        return self.status == "pushed"

    @property
    def skipped(self) -> bool:
        return self.status == "skipped"

    @property
    def failed(self) -> bool:
        return self.status == "failed"


async def _record_ledger(db_path: Optional[str], internal_id: int, fn, *args) -> None:
    """台账写的 fire-and-forget 包装: db_path 缺省不写; 写失败只 warning 绝不上抛
    (台账是补偿层, 不许反过来阻塞/炸掉邮件主流程)。sqlite 写 to_thread 出去,
    别的进程持写锁时等待发生在工作线程, 不冻 event loop。"""
    if db_path is None:
        return
    try:
        await asyncio.to_thread(fn, db_path, internal_id, *args)
    except Exception as e:  # noqa: BLE001 — fire-and-forget
        logger.warning(
            f"[kos-producer] ledger write failed internal_id={internal_id} "
            f"({getattr(fn, '__name__', fn)}): {e}"
        )


async def _put_and_record(
    client: KOSClient,
    db_path: Optional[str],
    internal_id: int,
    slug: str,
    content: str,
    source: str,
) -> KosPushOutcome:
    """put_page + 成功/失败双写台账 —— 增量 hook 与重试扫描共用的唯一推送路径。"""
    try:
        result = await asyncio.to_thread(client.put_page, slug, content)
        status = result.get("status") if isinstance(result, dict) else "?"
        chunks = result.get("chunks", 0) if isinstance(result, dict) else 0
        logger.info(
            f"[kos-producer] pushed internal_id={internal_id} slug={slug} status={status}"
        )
        await _record_ledger(
            db_path, internal_id, ingest_log.record_pushed, slug, int(chunks or 0), source
        )
        return KosPushOutcome(
            status="pushed", result=result if isinstance(result, dict) else {"raw": result}
        )
    except KOSError as e:
        transient = ingest_log.is_transient_error(e.code, getattr(e, "status", None))
        logger.warning(
            f"[kos-producer] push failed internal_id={internal_id} "
            f"slug={slug} code={e.code} transient={transient} msg={e}"
        )
        await _record_ledger(
            db_path, internal_id, ingest_log.record_failure,
            slug, e.code, str(e), source, transient,
        )
        return KosPushOutcome(status="failed", error_code=e.code, error=str(e))
    except Exception as e:  # noqa: BLE001 — fire-and-forget, 主流程不许被炸
        # 非 KOSError 的意外异常无稳定 code → E_KOS_UNEXPECTED, 按瞬时处理
        # (重试有界; 误判成永久 = 永久空洞, 正是 #59 的病根方向)。
        logger.warning(
            f"[kos-producer] unexpected error internal_id={internal_id} slug={slug}: {e}"
        )
        await _record_ledger(
            db_path, internal_id, ingest_log.record_failure,
            slug, "E_KOS_UNEXPECTED", str(e), source, True,
        )
        return KosPushOutcome(status="failed", error_code="E_KOS_UNEXPECTED", error=str(e))


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
    thread_parent: Optional[tuple[int, str]] = None,
    thread_root: Optional[tuple[int, str]] = None,
    client: Optional[KOSClient] = None,
    priority_floor: str = "normal",
    require_labeled: bool = False,
    dry_run: bool = False,
    db_path: Optional[str] = None,
) -> KosPushOutcome:
    """增量推单封邮件到 KOS mailagent-emails source, 返回三态 ``KosPushOutcome``。

    Skip cases (status='skipped', 不视为错):
        - ai_priority < priority_floor (增量过滤; bulk 路径不走这里) → reason='priority_floor'
        - require_labeled=True 且 AI 从未标注优先级 (issue #49) → reason='unlabeled'
        - bulk client 未 configured (MAILAGENT_BULK_CLIENT_* env 缺) → reason='not_configured'
        - dry_run → reason='dry_run', result 带 slug/content_bytes
    Failure (status='failed' + warning, 绝不上抛): KOSError / 其他 exception。

    ``db_path`` 非 None 时每个结局都写 kos_ingest_log 台账 (issue #59: pushed /
    skipped / failed + error_code + 退避排程), 写台账失败也只 warning ——
    fire-and-forget 纪律不变, KOS 链路任何问题都不阻塞邮件主流程。
    """
    slug_hint = f"sources/email/{internal_id}"

    async def _skip(reason: str, result: Optional[dict[str, Any]] = None) -> KosPushOutcome:
        await _record_ledger(
            db_path, internal_id, ingest_log.record_skipped, slug_hint, reason, "producer"
        )
        return KosPushOutcome(status="skipped", reason=reason, result=result)

    # labels 合并: caller 传完整 labels 优先; 否则用散的 ai_priority/ai_action
    merged: dict[str, Any] = dict(labels or {})
    if ai_priority and not merged.get("priority"):
        merged["priority"] = ai_priority
    if ai_action and not merged.get("action_type"):
        merged["action_type"] = ai_action

    effective_priority = merged.get("priority") or ai_priority
    if not passes_priority_gate(effective_priority, priority_floor, require_labeled):
        state = priority_label_state(effective_priority)
        unlabeled = require_labeled and state != LABEL_KNOWN
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            f"priority={effective_priority!r} "
            + (f"label={state}" if unlabeled else f"< floor={priority_floor!r}")
        )
        return await _skip("unlabeled" if unlabeled else "priority_floor")

    if client is None:
        client = make_bulk_kos_client()
    if not client.configured:
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            "bulk KOSClient not configured (MAILAGENT_BULK_CLIENT_* missing)"
        )
        return await _skip("not_configured")

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
        thread_parent=thread_parent,
        thread_root=thread_root,
    )

    if dry_run:
        logger.info(
            f"[kos-producer] dry-run internal_id={internal_id} "
            f"slug={slug} content_bytes={len(content.encode('utf-8'))}"
        )
        return await _skip("dry_run", result={
            "dry_run": True,
            "slug": slug,
            "content_bytes": len(content.encode("utf-8")),
        })

    return await _put_and_record(client, db_path, internal_id, slug, content, "producer")


def _load_labels(db_path: str, internal_id: int) -> dict[str, Any]:
    """llm_processing.labels_json 裸读 (镜像 bulk_ingest._get_labels, 重试路径用)。"""
    try:
        conn = sqlite3.connect(db_path, timeout=30)
        try:
            row = conn.execute(
                "SELECT labels_json FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
        finally:
            conn.close()
        if row and row[0]:
            return json.loads(row[0])
    except Exception:  # noqa: BLE001 — labels 缺失不阻断重推 (payload 少 AI 区块而已)
        pass
    return {}


async def repush_stored_email_to_kos(
    db_path: str,
    internal_id: int,
    *,
    client: Optional[KOSClient] = None,
    priority_floor: str = "normal",
    require_labeled: bool = False,
) -> KosPushOutcome:
    """重试扫描路径: 从 SQLite SSoT 重建 payload 并走与增量完全相同的推送+台账路径。

    与增量 hook 的差异只在输入来源 (metadata 行 vs 在内存的 Email 对象) —— payload
    builder / 过滤 gate / put+record 全部共用, 保证同一封邮件重推的 payload 与首推
    一致 (put_page 覆盖写幂等, 不触发无谓 re-embedding)。

    过滤 gate 在重推时**重新求值** (labels 可能已变): 不再够格 → record_skipped
    覆盖 failed 行退出重试队列 (当前过滤条件下这封本就不该入库)。
    本地 metadata 已删 (邮件被物理删除) → 无法重建, 记永久失败转 dead。
    """
    slug_hint = f"sources/email/{internal_id}"
    if client is None:
        client = make_bulk_kos_client()
    if not client.configured:
        # 防御: 重试 worker 入口已检查 configured, 这里不写台账 (凭据被移除时
        # 把 failed 行翻成 skipped 会让积压凭空"消失")。
        return KosPushOutcome(status="skipped", reason="not_configured")

    def _build() -> Optional[tuple]:
        from src.repository import EmailRepository

        repo = EmailRepository(db_path=db_path)
        meta = repo.get_metadata(internal_id)
        if meta is None:
            return None
        labels = _load_labels(db_path, internal_id)
        body = repo.get_body_markdown(internal_id, max_chars=200_000)
        atts = [
            {"filename": a.filename, "size": a.size_bytes, "content_type": a.content_type}
            for a in repo.get_attachments(internal_id)
            if not a.is_inline
        ]
        refs = resolve_thread_refs(db_path, internal_id)
        return meta, labels, body, atts, refs

    try:
        built = await asyncio.to_thread(_build)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[kos-retry] rebuild failed internal_id={internal_id}: {e}")
        await _record_ledger(
            db_path, internal_id, ingest_log.record_failure,
            slug_hint, "E_KOS_UNEXPECTED", f"rebuild failed: {e}", "producer", True,
        )
        return KosPushOutcome(status="failed", error_code="E_KOS_UNEXPECTED", error=str(e))
    if built is None:
        # 邮件行已不存在 (本地删除) → 永久失败: 没有可推的内容, 人工介入面可见
        logger.warning(
            f"[kos-retry] internal_id={internal_id} metadata gone, mark dead"
        )
        await _record_ledger(
            db_path, internal_id, ingest_log.record_failure,
            slug_hint, "E_KOS_SOURCE_GONE", "local email metadata missing", "producer", False,
        )
        return KosPushOutcome(
            status="failed", error_code="E_KOS_SOURCE_GONE", error="metadata gone"
        )

    meta, labels, body, atts, refs = built
    effective_priority = labels.get("priority")
    if not passes_priority_gate(effective_priority, priority_floor, require_labeled):
        state = priority_label_state(effective_priority)
        unlabeled = require_labeled and state != LABEL_KNOWN
        reason = "unlabeled" if unlabeled else "priority_floor"
        logger.debug(
            f"[kos-retry] internal_id={internal_id} no longer passes gate "
            f"({reason}), converge to skipped"
        )
        await _record_ledger(
            db_path, internal_id, ingest_log.record_skipped, slug_hint, reason, "producer"
        )
        return KosPushOutcome(status="skipped", reason=reason)

    slug, content = build_kos_page_payload(
        internal_id=internal_id,
        subject=meta.subject,
        sender=meta.sender,
        sender_name=meta.sender_name,
        to_addr=meta.to_addr,
        cc_addr=meta.cc_addr,
        date_iso=meta.date_received or "",
        mailbox=meta.mailbox,
        message_id=meta.message_id,
        thread_id=meta.thread_id,
        body_markdown=body,
        labels=labels,
        attachments=atts,
        notion_page_id=meta.notion_page_id,
        thread_parent=refs.get("parent"),
        thread_root=refs.get("root"),
    )
    return await _put_and_record(client, db_path, internal_id, slug, content, "producer")
