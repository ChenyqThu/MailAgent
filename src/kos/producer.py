"""KOS producer pipeline - mail-sync 邮件 sync 完后异步推 KOS (PR-2d).

Payload schema 按 wire spec §7.1 mailagent 模板:
    slug = 'sources/mailagent-{message_id_normalized}'
    content = YAML frontmatter (type/kind/title/source_of_truth/source_refs/
              tags/date_received/sender/mailbox/...) + body markdown

Priority floor 过滤 — 仅推 AI 已 classify 的 ai_priority ≥ floor:
    critical > urgent > important > normal > low

Fire-and-forget: caller (new_watcher) 用 asyncio.create_task 派发. KOS 不
可达 / KOSError 仅 warning 不 raise, 不阻塞主同步流程. 重启进程时未 push
邮件不重试 (KOS 主路径只是图谱丰富, 不丢功能性数据 — Mail.app + Notion
仍是 SSoT).

Dry-run: KOS_INGEST_DRY_RUN=true 时 build payload + log 但不真发 /ingest,
给上线灰度用.
"""

from __future__ import annotations

import asyncio
import re
from typing import Optional

from loguru import logger

from src.kos.client import KOSClient, KOSError
from src.models import Email


# Priority hierarchy (low → high). Index 越大优先级越高.
# unknown / 缺失 → 视为 'normal' (中性, 不主动 push 也不主动跳).
#
# 'urgent' 是 5 档英文 enum 中的一档, 但 LLM schema (src/llm_agent/schema.py)
# 实际 enum 只有 4 档中文 emoji ('🔴 紧急' / '🟡 重要' / '🟢 一般' / '⚪ 低').
# 中文 → 英文 mapping 见 _CN_PRIORITY_MAP. 英文 5 档 keep 让外部 caller 可以
# 传 'urgent' (例如未来 schema 变更或其他 priority 源).
_PRIORITY_ORDER: list[str] = ["low", "normal", "important", "urgent", "critical"]

# LLM agent 输出的中文 priority enum → 英文 normalize.
# 跟 src/llm_agent/schema.py:PRIORITY_ENUM 对齐. 缺 'urgent' 一档 (LLM
# schema 设计仅 4 档).
_CN_PRIORITY_MAP: dict[str, str] = {
    "🔴 紧急": "critical",
    "🟡 重要": "important",
    "🟢 一般": "normal",
    "⚪ 低": "low",
}


def _normalize_priority(raw: Optional[str]) -> str:
    """中文 emoji enum / 英文 enum / unknown → 英文 5 档之一.

    例:
        '🟡 重要' → 'important'
        '🟢 一般' → 'normal'
        'critical' → 'critical'  (英文已 normalize, lowercase 后命中)
        None / '' / 'foo' → 'normal' (unknown 中性)
    """
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
    """RFC 2822 Message-ID → safe slug part.

    '<abc.123@host.com>' → 'abc-123-host-com'
    '<m+1234%5Bbar%5D@example>' → 'm-1234-5bbar-5d-example'

    保留 lowercase alphanumeric, 其他字符 (含 @ . / + < > = % space) → dash,
    折叠多 dash, 修剪边缘 dash. 全空返 'unknown'.
    """
    if not message_id:
        return "unknown"
    s = message_id.strip().lstrip("<").rstrip(">").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "unknown"


def priority_at_or_above(actual: Optional[str], floor: str) -> bool:
    """检查 actual priority 是否 ≥ floor.

    actual 可以是英文 enum ('critical' / 'urgent' / 'important' / 'normal' /
    'low') 或 LLM 中文 emoji ('🔴 紧急' / '🟡 重要' / '🟢 一般' / '⚪ 低'),
    会先 _normalize_priority 转英文再比较.
    """
    a = _normalize_priority(actual)
    f = _normalize_priority(floor) if floor else "normal"
    a_idx = _PRIORITY_ORDER.index(a)
    f_idx = _PRIORITY_ORDER.index(f)
    return a_idx >= f_idx


def _yaml_quote(s: Optional[str]) -> str:
    """简单 YAML 单引号 quote (单引号自身 → 重复两次 escape)."""
    if s is None:
        return "''"
    return "'" + str(s).replace("'", "''") + "'"


def build_kos_page_payload(
    email_obj: Email,
    internal_id: int,
    *,
    body_markdown: Optional[str] = None,
    notion_page_id: Optional[str] = None,
    ai_priority: Optional[str] = None,
    ai_action: Optional[str] = None,
) -> tuple[str, str]:
    """构造 (slug, content) 给 KOS put_page.

    Args:
        email_obj: Email dataclass (subject/sender/date/mailbox 等 metadata)
        internal_id: SQLite ROWID / fallback slug
        body_markdown: 邮件正文 markdown — caller 从 EmailRepository.get_body_markdown
            取 (一般 PR-2b 抽出来的 markdown). 空时 frontmatter-only no body
        notion_page_id: Notion mirror page id (用于 source_refs)
        ai_priority: LLM 已 classify 的 priority — 也进 frontmatter + tags
        ai_action: LLM 已 classify 的 action_type — 也进 frontmatter

    Returns:
        (slug, content) 元组. slug 格式 'sources/mailagent-{normalized}',
        content 含 YAML frontmatter + markdown body.
    """
    msg_id_part = normalize_message_id_for_slug(
        email_obj.message_id or str(internal_id)
    )
    slug = f"sources/mailagent-{msg_id_part}"

    date_iso = email_obj.date.isoformat() if email_obj.date else ""
    subject = email_obj.subject or "(no subject)"

    # source_refs: mailagent + notion (if synced)
    refs_lines = [f"  - 'mailagent:{email_obj.message_id or internal_id}'"]
    if notion_page_id:
        refs_lines.append(
            f"  - 'https://www.notion.so/{notion_page_id.replace('-', '')}'"
        )

    # tags: 固定 mailagent-ingest + email + 按 priority/mailbox 动态加.
    # priority 转英文 normalize (LLM 中文 enum '🟡 重要' → 'important') 让
    # KOS 端 tag 过滤跟 priority floor 语义一致.
    tags = ["mailagent-ingest", "email"]
    if ai_priority:
        normalized = _normalize_priority(ai_priority)
        if normalized != "normal" or ai_priority.strip() in ("🟢 一般", "normal"):
            tags.append(f"priority-{normalized}")
    if email_obj.mailbox:
        # mailbox 中文 → 简单 ASCII-ize 用于 tag
        mailbox_tag = "inbox" if email_obj.mailbox == "收件箱" else (
            "sent" if email_obj.mailbox == "发件箱" else "other"
        )
        tags.append(f"mailbox-{mailbox_tag}")
    tags_inline = "[" + ", ".join(f"'{t}'" for t in tags) + "]"

    frontmatter_lines = [
        "---",
        "type: source",
        "kind: source",
        f"title: {_yaml_quote(subject)}",
        "status: draft",
        f"created: {_yaml_quote(date_iso)}",
        f"updated: {_yaml_quote(date_iso)}",
        "source_of_truth: mailagent-sqlite",
        "source_refs:",
        *refs_lines,
        f"tags: {tags_inline}",
        f"date_received: {_yaml_quote(date_iso)}",
        f"sender: {_yaml_quote(email_obj.sender)}",
        f"sender_name: {_yaml_quote(email_obj.sender_name)}",
        f"mailbox: {_yaml_quote(email_obj.mailbox)}",
        f"mailagent_internal_id: {internal_id}",
    ]
    if ai_priority:
        frontmatter_lines.append(f"ai_priority: {_yaml_quote(ai_priority)}")
    if ai_action:
        frontmatter_lines.append(f"ai_action: {_yaml_quote(ai_action)}")
    frontmatter_lines.append("---")

    frontmatter = "\n".join(frontmatter_lines)

    body = body_markdown.strip() if body_markdown else ""
    body_section = f"\n\n{body}\n" if body else "\n\n_(body not yet extracted)_\n"

    content = (
        f"{frontmatter}\n\n"
        f"# {subject}\n\n"
        f"> Ingested via mailagent kos push on {date_iso}.\n"
        f"{body_section}"
    )
    return slug, content


async def push_email_to_kos(
    email_obj: Email,
    internal_id: int,
    *,
    body_markdown: Optional[str] = None,
    notion_page_id: Optional[str] = None,
    ai_priority: Optional[str] = None,
    ai_action: Optional[str] = None,
    client: Optional[KOSClient] = None,
    priority_floor: str = "normal",
    dry_run: bool = False,
) -> Optional[dict]:
    """推单封邮件到 KOS. Skip 返 None; success 返 server response dict.

    Skip cases (返 None, 不视为错):
        - ai_priority < priority_floor
        - client 未 configured (3 个 env 缺)

    Failure handling (返 None + warning):
        - KOSError (任何 E_KOS_*) — fire-and-forget caller 不该 raise
        - 其他 exception — fallback E_INTERNAL warning

    Dry-run (返 dict 含 dry_run=True): build payload + log size, 不调网络.
    """
    # Step 1: priority floor 过滤
    if not priority_at_or_above(ai_priority, priority_floor):
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            f"priority={ai_priority!r} < floor={priority_floor!r}"
        )
        return None

    # Step 2: client config 检查
    if client is None:
        client = KOSClient()
    if not client.configured:
        logger.debug(
            f"[kos-producer] skip internal_id={internal_id} "
            "KOSClient not configured (3 env missing)"
        )
        return None

    # Step 3: build payload
    slug, content = build_kos_page_payload(
        email_obj,
        internal_id,
        body_markdown=body_markdown,
        notion_page_id=notion_page_id,
        ai_priority=ai_priority,
        ai_action=ai_action,
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

    # Step 4: KOS put_page (sync method 包 to_thread)
    try:
        result = await asyncio.to_thread(client.put_page, slug, content)
        status = result.get("status") if isinstance(result, dict) else "?"
        logger.info(
            f"[kos-producer] pushed internal_id={internal_id} "
            f"slug={slug} status={status}"
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
            f"[kos-producer] unexpected error internal_id={internal_id} "
            f"slug={slug}: {e}"
        )
        return None
