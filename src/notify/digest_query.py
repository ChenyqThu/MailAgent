"""DailyDigest 取数 + counts + bulk 候选 (Phase A, 纯数据层, 无 socket/LLM).

灵动岛"今日总结"巡检的数据地基:

1. ``fetch_recent_emails`` — JOIN ``email_metadata`` + ``llm_processing.labels_json``
   取最近 N 小时邮件的 metadata + AI 字段 (category/priority/action_type/ai_summary),
   按 priority DESC + date DESC 排序取前 ``max_emails``。
2. ``compute_counts`` — 确定性算 ``{unread, urgent, total, by_category}``。urgent 判定
   复用 ``island_dispatch.URGENT_PRIORITY_LABELS`` + ``ACTION_NEEDS_FLAG``。
3. ``select_bulk_candidates`` — 规则确定性选 bulk 候选 (FYI / 系统通知 → 归档; AI
   已分类的可清理 → 标完成 / 标已读)。**internal_id 列表在此确定性生成**, 每个 cap
   ``max_ids``, 只放 ``notion_page_id IS NOT NULL`` 的 (能 update-flag)。

counts 与 ids 都由代码算 (区别于 LLM): summarizer 只用它写文案 + 挑展示哪些候选,
真实归档数 = 代码给的 ids 数, LLM 出错爆炸半径限定在文案。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from loguru import logger

from src.llm_agent.schema import PRIORITY_ENUM
from src.notify.island_dispatch import ACTION_NEEDS_FLAG, URGENT_PRIORITY_LABELS

_BEIJING = timezone(timedelta(hours=8))

# bulk action id (与 digest_summarizer.BULK_ACTION_IDS / Phase B whitelist 一致)
BULK_ARCHIVE_NEWSLETTER = "bulk_archive_newsletter"
BULK_MARK_DONE = "bulk_mark_done"
BULK_MARK_READ = "bulk_mark_read"

# FYI / newsletter 类 — 命中即进 bulk_archive_newsletter 候选。
# action_type: schema ACTION_TYPE_INBOX/SENT 里的 "仅供参考" / "已完结" 是
# "看过即可、可清理" 语义; category: "🔔 系统通知" 是 newsletter/告警类。
_FYI_ACTION_TYPES = {"仅供参考", "已完结"}
_FYI_CATEGORIES = {"🔔 系统通知"}

# priority DESC 排序权重 (越前越紧急)。来自 schema PRIORITY_ENUM 顺序。
_PRIORITY_RANK: Dict[str, int] = {
    label: len(PRIORITY_ENUM) - i for i, label in enumerate(PRIORITY_ENUM)
}


@dataclass
class DigestEmailBrief:
    """一封邮件的 digest 投影 — metadata + llm_processing.labels_json AI 字段。"""

    internal_id: int
    subject: str
    sender_name: str
    category: str
    priority: str
    action_type: str
    ai_summary: str
    is_read: bool
    notion_page_id: Optional[str]


@dataclass
class BulkCandidate:
    """一个确定性选出的 bulk 候选 — action id + internal_id 列表 + 样例主题。"""

    action_id: str
    internal_ids: List[int] = field(default_factory=list)
    sample_subjects: List[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.internal_ids)


def _priority_rank(priority: str) -> int:
    return _PRIORITY_RANK.get(priority, 0)


def fetch_recent_emails(
    repo: Any,
    sync_store: Any,
    *,
    window_hours: int = 24,
    max_emails: int = 50,
    now: Optional[datetime] = None,
) -> List[DigestEmailBrief]:
    """取最近 ``window_hours`` 小时的邮件 brief (metadata + AI 字段)。

    JOIN ``email_metadata`` (date_received 窗口过滤) + ``llm_processing`` (按
    internal_id 取 labels_json 里的 category/priority/action_type/ai_summary)。
    LEFT JOIN — 没跑过 LLM 的邮件 AI 字段为空, 仍计入 (subject 进 brief)。
    按 priority DESC + date_received DESC 排序取前 ``max_emails``。

    Args:
        repo: ``EmailRepository`` (取 db_path; 实际查询直连 SQLite)。
        sync_store: ``SyncStore`` (保留作签名兼容; 当前实现用 repo.db_path)。
        window_hours: 回看窗口小时数。
        max_emails: 最多返回封数 (LLM brief cap)。
        now: 注入当前时间 (北京)，默认 ``datetime.now(_BEIJING)``。

    Returns:
        ``List[DigestEmailBrief]``，priority DESC + date DESC 排序，≤ max_emails。
    """
    if max_emails <= 0:
        return []
    now = now or datetime.now(_BEIJING)
    since = now - timedelta(hours=window_hours)
    # date_received 是 ISO 字符串, 字典序 == 时间序 (与 EmailRepository.list_metadata
    # / search_email_bodies 的 date_from 过滤同约定)。带时区偏移做窗口下界。
    since_iso = since.isoformat()

    db_path = str(getattr(repo, "db_path", None) or getattr(sync_store, "db_path", ""))
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT m.internal_id          AS internal_id,
                   COALESCE(m.subject, '') AS subject,
                   m.sender_name          AS sender_name,
                   m.is_read              AS is_read,
                   m.notion_page_id       AS notion_page_id,
                   m.date_received        AS date_received,
                   l.labels_json          AS labels_json
              FROM email_metadata m
              LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
             WHERE m.date_received >= ?
            """,
            (since_iso,),
        ).fetchall()
    except sqlite3.OperationalError as e:
        logger.warning(f"[digest] fetch_recent_emails query failed: {e}")
        return []
    finally:
        conn.close()

    briefs: List[DigestEmailBrief] = []
    for r in rows:
        labels = _parse_labels(r["labels_json"])
        briefs.append(
            DigestEmailBrief(
                internal_id=int(r["internal_id"]),
                subject=r["subject"] or "",
                sender_name=(r["sender_name"] or ""),
                category=(labels.get("category") or "").strip(),
                priority=(labels.get("priority") or "").strip(),
                action_type=(labels.get("action_type") or "").strip(),
                ai_summary=(labels.get("ai_summary") or "").strip(),
                is_read=bool(r["is_read"]),
                notion_page_id=r["notion_page_id"],
            )
        )

    # priority DESC + date_received DESC。date_received 已 ISO 字符串可直接降序比较;
    # rows 已带 date_received, 用 (priority_rank, date) 复合 key 排序。
    date_by_id = {int(r["internal_id"]): (r["date_received"] or "") for r in rows}
    briefs.sort(
        key=lambda b: (_priority_rank(b.priority), date_by_id.get(b.internal_id, "")),
        reverse=True,
    )
    return briefs[:max_emails]


def _parse_labels(raw: Any) -> Dict[str, Any]:
    """labels_json (TEXT) → dict; 非法 / 空 → {}。"""
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def compute_counts(briefs: List[DigestEmailBrief]) -> Dict[str, Any]:
    """确定性算 counts: ``{unread, urgent, total, by_category}``。

    urgent 判定复用 ``island_dispatch.URGENT_PRIORITY_LABELS`` +
    ``ACTION_NEEDS_FLAG`` (与 ``handlers.handle_ai_reviewed`` 飞书通知规则同):
    priority ∈ URGENT_PRIORITY_LABELS AND action_type ∈ ACTION_NEEDS_FLAG。
    """
    unread = 0
    urgent = 0
    by_category: Dict[str, int] = {}
    for b in briefs:
        if not b.is_read:
            unread += 1
        if b.priority in URGENT_PRIORITY_LABELS and b.action_type in ACTION_NEEDS_FLAG:
            urgent += 1
        if b.category:
            by_category[b.category] = by_category.get(b.category, 0) + 1
    return {
        "unread": unread,
        "urgent": urgent,
        "total": len(briefs),
        "by_category": by_category,
    }


def select_bulk_candidates(
    briefs: List[DigestEmailBrief],
    *,
    max_ids: int = 30,
) -> List[BulkCandidate]:
    """规则确定性选 bulk 候选 (非 LLM)。internal_id 列表在此生成。

    规则 (Phase A):
    - ``bulk_archive_newsletter``: category ∈ FYI 类 (🔔 系统通知) 或 action_type ∈
      FYI 类 (仅供参考 / 已完结) → 可批量归档 (标完成)。
    - ``bulk_mark_read``: 已被 LLM 分类 (priority 非空) 且仍未读的邮件 → 可批量标已读。

    约束:
    - 每个候选只放 ``notion_page_id IS NOT NULL`` 的 (能走 notion update-flag)。
    - 每个候选 internal_ids cap ``max_ids``; sample_subjects 取前 3。
    - 候选为空 (无命中邮件) 不返回该 candidate。
    """
    archive_ids: List[int] = []
    archive_subjects: List[str] = []
    mark_read_ids: List[int] = []
    mark_read_subjects: List[str] = []

    for b in briefs:
        # 只处理已同步到 Notion 的 (能 update-flag)
        if not b.notion_page_id:
            continue

        is_fyi = b.category in _FYI_CATEGORIES or b.action_type in _FYI_ACTION_TYPES
        if is_fyi and len(archive_ids) < max_ids:
            archive_ids.append(b.internal_id)
            if len(archive_subjects) < 3 and b.subject:
                archive_subjects.append(b.subject)

        # 已分类 (priority 非空 = 跑过 LLM) 且未读 → 可批量标已读
        if b.priority and not b.is_read and len(mark_read_ids) < max_ids:
            mark_read_ids.append(b.internal_id)
            if len(mark_read_subjects) < 3 and b.subject:
                mark_read_subjects.append(b.subject)

    candidates: List[BulkCandidate] = []
    if archive_ids:
        candidates.append(
            BulkCandidate(
                action_id=BULK_ARCHIVE_NEWSLETTER,
                internal_ids=archive_ids,
                sample_subjects=archive_subjects,
            )
        )
    if mark_read_ids:
        candidates.append(
            BulkCandidate(
                action_id=BULK_MARK_READ,
                internal_ids=mark_read_ids,
                sample_subjects=mark_read_subjects,
            )
        )
    return candidates
