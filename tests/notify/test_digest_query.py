"""Tests for src.notify.digest_query (灵动岛 Phase 3 DailyDigest 取数 + counts + 候选).

建临时 SQLite (SyncStore 建 email_metadata schema + LLMProcessingStore 建
llm_processing), 直接 INSERT fixture rows, 验:
- fetch_recent_emails 的 JOIN / 窗口过滤 / priority+date 排序 / max_emails cap
- compute_counts 各 count (unread / urgent / by_category)
- select_bulk_candidates 规则命中 + max_ids cap + notion_page_id IS NULL 被过滤

全 mock SQLite, 不调 LLM / socket.
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.llm_agent.store import LLMProcessingStore
from src.mail.sync_store import SyncStore
from src.notify.digest_query import (
    BULK_ARCHIVE_NEWSLETTER,
    BULK_MARK_READ,
    BulkCandidate,
    DigestEmailBrief,
    compute_counts,
    fetch_recent_emails,
    select_bulk_candidates,
)
from src.repository import EmailRepository

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 5, 26, 9, 0, 0, tzinfo=_BJ)  # 周二 09:00


# ============================================================
# Fixtures
# ============================================================


@pytest.fixture
def db(tmp_path: Path) -> Path:
    """空 SQLite + email_metadata + llm_processing schema。"""
    p = tmp_path / "t.db"
    SyncStore(str(p))            # 建 email_metadata 等主表
    LLMProcessingStore(str(p))   # 建 llm_processing 表
    return p


@pytest.fixture
def repo(db: Path) -> EmailRepository:
    return EmailRepository(db_path=str(db))


def _iso(hours_ago: float) -> str:
    """now - hours_ago 的 ISO 字符串 (带北京时区)。"""
    return (_NOW - timedelta(hours=hours_ago)).isoformat()


def _insert_email(
    db: Path,
    internal_id: int,
    *,
    subject: str = "S",
    sender_name: str = "Sender",
    date_received: str | None = None,
    is_read: int = 0,
    notion_page_id: str | None = "page-x",
    labels: dict | None = None,
) -> None:
    """直接 INSERT 一行 email_metadata (+ 可选 llm_processing labels_json)。"""
    if date_received is None:
        date_received = _iso(1)
    now = time.time()
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        INSERT INTO email_metadata
            (internal_id, subject, sender_name, date_received, mailbox,
             is_read, is_flagged, sync_status, notion_page_id,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, '收件箱', ?, 0, 'synced', ?, ?, ?)
        """,
        (internal_id, subject, sender_name, date_received, is_read,
         notion_page_id, now, now),
    )
    if labels is not None:
        conn.execute(
            """
            INSERT INTO llm_processing
                (internal_id, status, labels_json, created_at, updated_at)
            VALUES (?, 'success', ?, ?, ?)
            """,
            (internal_id, json.dumps(labels, ensure_ascii=False), now, now),
        )
    conn.commit()
    conn.close()


# ============================================================
# fetch_recent_emails — JOIN / 窗口 / 排序 / cap
# ============================================================


class TestFetchRecentEmails:
    def test_join_reads_labels(self, db: Path, repo: EmailRepository):
        _insert_email(db, 1, subject="预算", labels={
            "category": "📊 项目管理", "priority": "🟡 重要",
            "action_type": "需要回复", "ai_summary": "Gary 问预算",
        })
        briefs = fetch_recent_emails(repo, None, now=_NOW)
        assert len(briefs) == 1
        b = briefs[0]
        assert isinstance(b, DigestEmailBrief)
        assert b.internal_id == 1
        assert b.subject == "预算"
        assert b.category == "📊 项目管理"
        assert b.priority == "🟡 重要"
        assert b.action_type == "需要回复"
        assert b.ai_summary == "Gary 问预算"
        assert b.notion_page_id == "page-x"

    def test_left_join_no_labels(self, db: Path, repo: EmailRepository):
        """没跑过 LLM 的邮件 (无 llm_processing 行) 仍计入, AI 字段空。"""
        _insert_email(db, 1, subject="未分类", labels=None)
        briefs = fetch_recent_emails(repo, None, now=_NOW)
        assert len(briefs) == 1
        assert briefs[0].subject == "未分类"
        assert briefs[0].category == ""
        assert briefs[0].priority == ""

    def test_window_filter_excludes_old(self, db: Path, repo: EmailRepository):
        _insert_email(db, 1, subject="新", date_received=_iso(2))    # 窗口内
        _insert_email(db, 2, subject="旧", date_received=_iso(48))   # 窗口外 (>24h)
        briefs = fetch_recent_emails(repo, None, window_hours=24, now=_NOW)
        ids = [b.internal_id for b in briefs]
        assert ids == [1]

    def test_sort_priority_desc_then_date_desc(self, db: Path, repo: EmailRepository):
        # 紧急(早) / 重要(晚) / 一般(最晚) → 排序应 紧急 > 重要 > 一般
        _insert_email(db, 1, date_received=_iso(5),
                      labels={"priority": "🔴 紧急"})
        _insert_email(db, 2, date_received=_iso(1),
                      labels={"priority": "🟡 重要"})
        _insert_email(db, 3, date_received=_iso(0.5),
                      labels={"priority": "🟢 一般"})
        briefs = fetch_recent_emails(repo, None, now=_NOW)
        assert [b.internal_id for b in briefs] == [1, 2, 3]

    def test_sort_same_priority_by_date_desc(self, db: Path, repo: EmailRepository):
        _insert_email(db, 1, date_received=_iso(5),
                      labels={"priority": "🟡 重要"})
        _insert_email(db, 2, date_received=_iso(1),  # 更新 → 排前
                      labels={"priority": "🟡 重要"})
        briefs = fetch_recent_emails(repo, None, now=_NOW)
        assert [b.internal_id for b in briefs] == [2, 1]

    def test_max_emails_cap(self, db: Path, repo: EmailRepository):
        for i in range(1, 11):
            _insert_email(db, i, date_received=_iso(i * 0.1),
                          labels={"priority": "🟢 一般"})
        briefs = fetch_recent_emails(repo, None, max_emails=3, now=_NOW)
        assert len(briefs) == 3

    def test_max_emails_zero(self, db: Path, repo: EmailRepository):
        _insert_email(db, 1)
        assert fetch_recent_emails(repo, None, max_emails=0, now=_NOW) == []

    def test_malformed_labels_json_tolerated(self, db: Path, repo: EmailRepository):
        _insert_email(db, 1, labels=None)
        # 手塞一个非法 JSON 的 llm_processing 行
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO llm_processing (internal_id, status, labels_json, "
            "created_at, updated_at) VALUES (1, 'success', '{bad json', ?, ?)",
            (time.time(), time.time()),
        )
        conn.commit()
        conn.close()
        briefs = fetch_recent_emails(repo, None, now=_NOW)
        assert len(briefs) == 1
        assert briefs[0].category == ""  # 非法 JSON → 空 AI 字段


# ============================================================
# compute_counts
# ============================================================


class TestComputeCounts:
    def _brief(self, **kw) -> DigestEmailBrief:
        base = dict(
            internal_id=1, subject="S", sender_name="X", category="",
            priority="", action_type="", ai_summary="", is_read=True,
            notion_page_id="p",
        )
        base.update(kw)
        return DigestEmailBrief(**base)

    def test_empty(self):
        c = compute_counts([])
        assert c == {"unread": 0, "urgent": 0, "total": 0, "by_category": {}}

    def test_unread_count(self):
        briefs = [
            self._brief(internal_id=1, is_read=False),
            self._brief(internal_id=2, is_read=True),
            self._brief(internal_id=3, is_read=False),
        ]
        c = compute_counts(briefs)
        assert c["unread"] == 2
        assert c["total"] == 3

    def test_urgent_count_requires_priority_and_action(self):
        briefs = [
            # 紧急 + 需要回复 → urgent
            self._brief(internal_id=1, priority="🔴 紧急", action_type="需要回复"),
            # 重要 + 需要决策 → urgent
            self._brief(internal_id=2, priority="🟡 重要", action_type="需要决策"),
            # 紧急 但 action 仅供参考 (不在 ACTION_NEEDS_FLAG) → 不 urgent
            self._brief(internal_id=3, priority="🔴 紧急", action_type="仅供参考"),
            # 一般 + 需要回复 (priority 不在 URGENT) → 不 urgent
            self._brief(internal_id=4, priority="🟢 一般", action_type="需要回复"),
        ]
        c = compute_counts(briefs)
        assert c["urgent"] == 2

    def test_by_category(self):
        briefs = [
            self._brief(internal_id=1, category="🔔 系统通知"),
            self._brief(internal_id=2, category="🔔 系统通知"),
            self._brief(internal_id=3, category="📊 项目管理"),
            self._brief(internal_id=4, category=""),  # 空 category 不计
        ]
        c = compute_counts(briefs)
        assert c["by_category"] == {"🔔 系统通知": 2, "📊 项目管理": 1}


# ============================================================
# select_bulk_candidates
# ============================================================


class TestSelectBulkCandidates:
    def _brief(self, **kw) -> DigestEmailBrief:
        base = dict(
            internal_id=1, subject="S", sender_name="X", category="",
            priority="", action_type="", ai_summary="", is_read=True,
            notion_page_id="p",
        )
        base.update(kw)
        return DigestEmailBrief(**base)

    def test_fyi_category_to_archive(self):
        briefs = [
            self._brief(internal_id=1, subject="告警", category="🔔 系统通知"),
            self._brief(internal_id=2, subject="Newsletter", category="🔔 系统通知"),
        ]
        cands = select_bulk_candidates(briefs)
        archive = [c for c in cands if c.action_id == BULK_ARCHIVE_NEWSLETTER]
        assert len(archive) == 1
        assert sorted(archive[0].internal_ids) == [1, 2]
        assert "告警" in archive[0].sample_subjects

    def test_fyi_action_type_to_archive(self):
        briefs = [
            self._brief(internal_id=1, action_type="仅供参考"),
            self._brief(internal_id=2, action_type="已完结"),
        ]
        cands = select_bulk_candidates(briefs)
        archive = [c for c in cands if c.action_id == BULK_ARCHIVE_NEWSLETTER]
        assert len(archive) == 1
        assert sorted(archive[0].internal_ids) == [1, 2]

    def test_classified_unread_to_mark_read(self):
        briefs = [
            # 已分类 (priority 非空) 且未读 → mark_read 候选
            self._brief(internal_id=1, priority="🟢 一般", is_read=False),
            # 已分类但已读 → 不进
            self._brief(internal_id=2, priority="🟢 一般", is_read=True),
            # 未分类 (priority 空) 且未读 → 不进 (没跑过 LLM)
            self._brief(internal_id=3, priority="", is_read=False),
        ]
        cands = select_bulk_candidates(briefs)
        mark_read = [c for c in cands if c.action_id == BULK_MARK_READ]
        assert len(mark_read) == 1
        assert mark_read[0].internal_ids == [1]

    def test_notion_page_id_null_filtered(self):
        """只放 notion_page_id IS NOT NULL 的 (能 update-flag)。"""
        briefs = [
            self._brief(internal_id=1, category="🔔 系统通知", notion_page_id="p"),
            self._brief(internal_id=2, category="🔔 系统通知", notion_page_id=None),
        ]
        cands = select_bulk_candidates(briefs)
        archive = [c for c in cands if c.action_id == BULK_ARCHIVE_NEWSLETTER]
        assert archive[0].internal_ids == [1]  # 2 被过滤

    def test_max_ids_cap(self):
        briefs = [
            self._brief(internal_id=i, category="🔔 系统通知")
            for i in range(1, 11)
        ]
        cands = select_bulk_candidates(briefs, max_ids=3)
        archive = [c for c in cands if c.action_id == BULK_ARCHIVE_NEWSLETTER][0]
        assert len(archive.internal_ids) == 3
        assert archive.count == 3

    def test_sample_subjects_capped_at_three(self):
        briefs = [
            self._brief(internal_id=i, subject=f"Sub{i}", category="🔔 系统通知")
            for i in range(1, 6)
        ]
        cands = select_bulk_candidates(briefs)
        archive = [c for c in cands if c.action_id == BULK_ARCHIVE_NEWSLETTER][0]
        assert len(archive.sample_subjects) == 3

    def test_no_candidates_returns_empty(self):
        briefs = [
            self._brief(internal_id=1, category="📊 项目管理", is_read=True),
        ]
        assert select_bulk_candidates(briefs) == []

    def test_bulk_candidate_count_property(self):
        c = BulkCandidate(action_id="x", internal_ids=[1, 2, 3])
        assert c.count == 3
