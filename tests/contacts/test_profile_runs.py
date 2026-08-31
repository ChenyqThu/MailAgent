"""联系人画像执行台账 (`contact_profile_run`, DB v72) —— task 08-27 L4 P4a。

画像此前一轮记录都没有 (统计只 logger.info 一句就丢了)，团队页的记录列对它永远是空态。
这里盯两件事: ① 每轮批处理都落一行, 失败也落; ② status 三值的判据。

🔴 全程 tmp_path 建库。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.contacts import profile
from src.contacts.profile_config import ContactProfileAgentConfig
from src.contacts.profile_runs import (
    classify_batch_status,
    count_profile_runs,
    list_profile_runs,
    record_profile_run,
)
from src.mail.sync_store import SyncStore


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_contact(path, contact_id: int, *, mail_count: int = 80):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, mail_count, sent_to_count, "
            "created_at, updated_at) VALUES (?, ?, 'person', ?, 1, 1, 1)",
            (contact_id, f"Person {contact_id}", mail_count),
        )
        conn.commit()


def _runs(path):
    return list_profile_runs(path)


# ── status 判据 (classify_batch_status 是单源) ──────────────────────────────────


@pytest.mark.parametrize(
    "stats, error, expected",
    [
        ({"candidates": 0, "ran": 0, "ok": 0, "skipped": 0, "failed": 0}, None, "noop"),
        ({"candidates": 3, "ran": 3, "ok": 3, "skipped": 0, "failed": 0}, None, "ok"),
        ({"candidates": 3, "ran": 3, "ok": 2, "skipped": 0, "failed": 1}, None, "ok"),
        # 跑了但一个都没成 —— 判 ok 就是谎报, 记录列会显示成一次正常执行。
        ({"candidates": 3, "ran": 3, "ok": 0, "skipped": 0, "failed": 3}, None, "fail"),
        # 全被 claim 挡下 (ran=0) 不是失败: 没开跑就没跑砸。
        ({"candidates": 3, "ran": 0, "ok": 0, "skipped": 0, "failed": 0}, None, "ok"),
        # 批级异常压过一切 —— 连候选都没选出来时 candidates=0 也不能落成 noop。
        ({"candidates": 0, "ran": 0, "ok": 0, "skipped": 0, "failed": 0}, "boom", "fail"),
    ],
)
def test_classify_batch_status(stats, error, expected):
    assert classify_batch_status(stats, error=error) == expected


# ── 批处理落库 ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_records_one_ledger_row_with_counts(db):
    _seed_contact(db, 1)
    _seed_contact(db, 2)

    async def fake_generate(db_path, contact_id, **kwargs):
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "UPDATE contact SET profile_status='ok', profile_updated_at=2, "
                "profile_mail_count=mail_count WHERE id=?",
                (contact_id,),
            )
            conn.commit()
        return "ok" if contact_id == 1 else "skipped"

    stats = await profile.run_profile_batch(
        db_path=db,
        cfg=ContactProfileAgentConfig(row_exists=True, enabled=True, daily_limit=10),
        now_ms=1_700_000_000_000,
        generate_fn=fake_generate,
    )
    assert stats == {"candidates": 2, "ran": 2, "ok": 1, "skipped": 1, "failed": 0}

    rows = _runs(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "ok"
    assert (row["candidates"], row["ran"], row["ok_count"], row["skipped"], row["failed"]) == (
        2, 2, 1, 1, 0,
    )
    assert row["error"] is None
    # 🔴 毫秒 —— 与 contact.profile_updated_at 同一把尺子, 不是 time.time() 秒。
    assert row["started_at"] == 1_700_000_000_000
    assert row["completed_at"] >= row["started_at"]
    assert count_profile_runs(db) == 1


@pytest.mark.asyncio
async def test_batch_with_no_candidates_records_noop(db):
    """没有候选人也要留痕: 「今天没人需要更新画像」与「今天根本没跑」在记录列上必须分得开。"""
    stats = await profile.run_profile_batch(
        db_path=db,
        cfg=ContactProfileAgentConfig(row_exists=True, enabled=True),
        now_ms=1_700_000_000_000,
    )
    assert stats["candidates"] == 0
    rows = _runs(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "noop"


@pytest.mark.asyncio
async def test_batch_all_contacts_failed_records_fail(db):
    _seed_contact(db, 1)

    async def boom(db_path, contact_id, **kwargs):
        raise RuntimeError("llm down")

    stats = await profile.run_profile_batch(
        db_path=db,
        cfg=ContactProfileAgentConfig(row_exists=True, enabled=True),
        now_ms=1_700_000_000_000,
        generate_fn=boom,
    )
    assert stats["failed"] == 1
    rows = _runs(db)
    assert len(rows) == 1 and rows[0]["status"] == "fail"


@pytest.mark.asyncio
async def test_batch_level_exception_still_records_and_reraises(db, monkeypatch):
    """选候选人这一步就炸 —— 台账仍要落一行 fail + error, 原异常照常上抛。"""
    _seed_contact(db, 1)

    def explode(conn, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(profile, "select_profile_candidates", explode)

    with pytest.raises(sqlite3.OperationalError, match="locked"):
        await profile.run_profile_batch(
            db_path=db,
            cfg=ContactProfileAgentConfig(row_exists=True, enabled=True),
            now_ms=1_700_000_000_000,
        )

    rows = _runs(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "fail"
    assert "locked" in (rows[0]["error"] or "")


# ── 读面 ───────────────────────────────────────────────────────────────────────


def test_list_profile_runs_is_newest_first_and_paginates(db):
    for i in range(5):
        record_profile_run(
            db,
            started_at_ms=1_700_000_000_000 + i * 1000,
            stats={"candidates": 1, "ran": 1, "ok": 1, "skipped": 0, "failed": 0},
        )
    assert count_profile_runs(db) == 5
    page1 = list_profile_runs(db, limit=2, offset=0)
    page2 = list_profile_runs(db, limit=2, offset=2)
    assert [r["started_at"] for r in page1] == [
        1_700_000_004_000,
        1_700_000_003_000,
    ]
    assert len({r["id"] for r in page1} & {r["id"] for r in page2}) == 0


def test_ledger_read_on_db_without_table_is_empty_not_error(tmp_path):
    """老库还没跑到 v72 → 读侧空态, 不抛 (「没这张表」与「还没跑过」的处置一样)。"""
    bare = tmp_path / "bare.db"
    sqlite3.connect(str(bare)).close()
    assert list_profile_runs(str(bare)) == []
    assert count_profile_runs(str(bare)) == 0
    assert record_profile_run(
        str(bare), started_at_ms=1, stats={"candidates": 0}
    ) is None
