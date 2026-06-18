"""Phase A 搜索测试：

- G-A2 自我收敛信号：``search_email_bodies_with_meta`` 的 ``limit + 1`` 探针 →
  精确 ``has_more`` + 裁回 ``limit``（top-limit 逐条不变，零结果回归）。
- G-A6 中文 trigram 翻默认 ON：config 字段默认 True + 子串召回行为。

复用 ``test_search_query_behavior`` 的 DDL（同一份建表 SQL，避免漂移）。
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from src.config import Config
from src.repository import EmailRepository
from tests.repository.test_search_query_behavior import DDL


def _build_db(tmp_path: Path, emails: list[dict]) -> Path:
    db = tmp_path / "self_convergence.db"
    conn = sqlite3.connect(str(db))
    now = time.time()
    try:
        conn.executescript(DDL)
        for e in emails:
            conn.execute(
                """INSERT INTO email_metadata
                   (internal_id, subject, sender, sender_name, to_addr, cc_addr,
                    date_received, mailbox, is_read, is_flagged, is_pinned,
                    is_important, ai_priority, notion_page_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, ?, ?)""",
                (
                    e["internal_id"], e["subject"], e["sender"], e.get("sender_name", ""),
                    e.get("to_addr", ""), e.get("cc_addr", ""), e["date_received"],
                    e.get("mailbox", "收件箱"), now, now,
                ),
            )
            for table in ("email_body_fts", "email_body_fts_trigram"):
                conn.execute(
                    f"INSERT INTO {table} (rowid, body_markdown, subject, sender) "
                    "VALUES (?, ?, ?, ?)",
                    (e["internal_id"], e["body_markdown"], e["subject"], e["sender"]),
                )
        conn.commit()
    finally:
        conn.close()
    return db


def _report_emails(n: int) -> list[dict]:
    return [
        {
            "internal_id": i,
            "subject": f"Report {i}",
            "sender": f"user{i}@example.com",
            "date_received": f"2026-06-{(i % 27) + 1:02d}T10:00:00",
            "body_markdown": "quarterly report numbers",
        }
        for i in range(1, n + 1)
    ]


# ── G-A2: limit+1 探针 → 精确 has_more + 裁回 limit ───────────────────────────


def test_has_more_true_when_truncated(tmp_path: Path):
    repo = EmailRepository(db_path=str(_build_db(tmp_path, _report_emails(5))), trigram_enabled=False)
    res = repo.search_email_bodies_with_meta("report", limit=2)
    assert len(res.hits) == 2  # 裁回 limit
    assert res.has_more is True  # 还有更多 (5 > 2)


def test_has_more_false_when_complete(tmp_path: Path):
    repo = EmailRepository(db_path=str(_build_db(tmp_path, _report_emails(3))), trigram_enabled=False)
    res = repo.search_email_bodies_with_meta("report", limit=10)
    assert len(res.hits) == 3
    assert res.has_more is False


def test_has_more_false_at_exact_limit(tmp_path: Path):
    # 命中数恰等于 limit → has_more False（探针多取 1 条但只命中 limit 条）。
    repo = EmailRepository(db_path=str(_build_db(tmp_path, _report_emails(3))), trigram_enabled=False)
    res = repo.search_email_bodies_with_meta("report", limit=3)
    assert len(res.hits) == 3
    assert res.has_more is False


def test_empty_result_has_no_more(tmp_path: Path):
    repo = EmailRepository(db_path=str(_build_db(tmp_path, _report_emails(3))), trigram_enabled=False)
    res = repo.search_email_bodies_with_meta("nonexistentkeyword", limit=10)
    assert res.hits == []
    assert res.has_more is False


def test_truncated_prefix_identical_to_untruncated(tmp_path: Path):
    # 零结果回归：探针裁回的 top-limit 与取大 limit 的前 limit 条逐条一致（顺序+id）。
    repo = EmailRepository(db_path=str(_build_db(tmp_path, _report_emails(6))), trigram_enabled=False)
    full = repo.search_email_bodies_with_meta("report", limit=6)
    trunc = repo.search_email_bodies_with_meta("report", limit=3)
    assert [h.internal_id for h in trunc.hits] == [h.internal_id for h in full.hits[:3]]
    assert trunc.has_more is True
    assert full.has_more is False


# ── G-A6: 中文 trigram 翻默认 ON ───────────────────────────────────────────────


def test_trigram_default_is_on():
    # config 字段默认 True（Phase A G-A6 翻默认），hermetic：直读字段默认值，不依赖 env/.env。
    assert Config.model_fields["search_trigram_enabled"].default is True


def test_chinese_substring_recall_with_trigram(tmp_path: Path):
    # G-A6 DoD：搜「产品」命中正文「本周产品评审」内部（unicode61 把连续中文当单 token，
    # 裸搜命中不了，trigram 子串路由才能召回）。trigram_enabled=True = 翻默认后的有效行为。
    db = _build_db(
        tmp_path,
        [{
            "internal_id": 1, "subject": "周会", "sender": "a@x.com",
            "date_received": "2026-06-10T10:00:00", "body_markdown": "本周产品评审安排如下",
        }],
    )
    res = EmailRepository(db_path=str(db), trigram_enabled=True).search_email_bodies_with_meta(
        "产品", limit=10
    )
    assert [h.internal_id for h in res.hits] == [1]


def test_trigram_path_has_more_truncation(tmp_path: Path):
    # G-A2 × trigram 路径：探针 limit+1 在 trigram 路由下也精确给 has_more（review LOW 补测）。
    db = _build_db(
        tmp_path,
        [
            {
                "internal_id": i, "subject": f"周报 {i}", "sender": f"u{i}@x.com",
                "date_received": f"2026-06-{i:02d}T10:00:00",
                "body_markdown": f"本周产品评审第 {i} 次纪要",
            }
            for i in range(1, 5)  # 4 封都含子串「产品」
        ],
    )
    repo = EmailRepository(db_path=str(db), trigram_enabled=True)
    trunc = repo.search_email_bodies_with_meta("产品", limit=2)
    assert len(trunc.hits) == 2
    assert trunc.has_more is True
    full = repo.search_email_bodies_with_meta("产品", limit=10)
    assert len(full.hits) == 4
    assert full.has_more is False
