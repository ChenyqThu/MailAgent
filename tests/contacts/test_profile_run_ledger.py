"""联系人画像批处理的执行台账 (v73 起写 `agent_run_log` + 逐人步骤行)。

v72 的 `contact_profile_run` 批级统计表已整体迁入统一台账 (task 08-27 P4a run
transcript)。这里盯三件事: ① 每轮批处理落一行 run + 逐人 tool 步骤, 失败也落;
② 批级 status 的判据 (`_batch_run_status`, 9 值域子集); ③ 步骤行的 detail 是人话
(名字 + 结果), skipped 不标 ✗、failed 标 ✗。

🔴 全程 tmp_path 建库。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.agents.run_log import list_run_logs, list_run_steps
from src.contacts import profile
from src.contacts.profile import _batch_run_status, _batch_summary
from src.contacts.profile_config import (
    CONTACT_PROFILE_AGENT_ID,
    ContactProfileAgentConfig,
)
from src.mail.sync_store import SyncStore


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_contact(path, contact_id: int, *, name: str = "", mail_count: int = 80):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, mail_count, sent_to_count, "
            "created_at, updated_at) VALUES (?, ?, 'person', ?, 1, 1, 1)",
            (contact_id, name or f"Person {contact_id}", mail_count),
        )
        conn.commit()


def _runs(path):
    return list_run_logs(path, agent_id=CONTACT_PROFILE_AGENT_ID)


# ── status 判据 (_batch_run_status 是单源, 值域 = 9 值域子集) ───────────────────


@pytest.mark.parametrize(
    "stats, expected",
    [
        ({"candidates": 0, "ran": 0, "ok": 0, "skipped": 0, "failed": 0}, "skipped"),
        ({"candidates": 3, "ran": 3, "ok": 3, "skipped": 0, "failed": 0}, "completed"),
        ({"candidates": 3, "ran": 3, "ok": 2, "skipped": 0, "failed": 1}, "completed"),
        # 跑了但一个都没成 —— 判 completed 就是谎报, 记录列会显示成一次正常执行。
        ({"candidates": 3, "ran": 3, "ok": 0, "skipped": 0, "failed": 3}, "failed"),
        # 全被 claim 挡下 (ran=0) 不是失败: 没开跑就没跑砸。
        ({"candidates": 3, "ran": 0, "ok": 0, "skipped": 0, "failed": 0}, "completed"),
    ],
)
def test_batch_run_status(stats, expected):
    assert _batch_run_status(stats) == expected


def test_batch_summary_strings():
    assert _batch_summary({"candidates": 0}) == "没有待更新画像的联系人"
    assert (
        _batch_summary({"candidates": 3, "ok": 2, "skipped": 1, "failed": 0})
        == "画像 2 人 · 跳过 1 · 失败 0"
    )


# ── 批处理落库 ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_records_run_with_per_contact_steps(db):
    _seed_contact(db, 1, name="张三")
    _seed_contact(db, 2, name="李四")

    async def fake_generate(db_path, contact_id, **kwargs):
        now_ms = kwargs["now_ms"]
        with sqlite3.connect(db_path) as conn:
            if contact_id == 1:
                conn.execute(
                    "UPDATE contact SET profile_status='ok', profile_updated_at=?, "
                    "profile_mail_count=mail_count, profile_model='m1', "
                    "profile_json='{\"formal_name\": \"张三\"}' WHERE id=?",
                    (now_ms, contact_id),
                )
            else:
                conn.execute(
                    "UPDATE contact SET profile_status='skipped', "
                    "profile_error='{\"reason\": \"7 天内已刷新\"}' WHERE id=?",
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
    assert row["agent_id"] == CONTACT_PROFILE_AGENT_ID
    assert row["status"] == "completed"
    assert row["summary"] == "画像 1 人 · 跳过 1 · 失败 0"
    assert row["trigger_kind"] == "schedule"
    assert row["error"] is None
    # 🔴 毫秒 —— 与 contact.profile_updated_at 同一把尺子, 不是 time.time() 秒。
    assert row["started_at"] == 1_700_000_000_000
    assert row["completed_at"] >= row["started_at"]

    steps = list_run_steps(db, int(row["id"]))
    assert row["step_count"] == len(steps)
    # 形态: trig → 逐人 tool → out (design §8.1, 零 think)。
    assert [s["kind"] for s in steps] == ["trig", "tool", "tool", "out"]
    assert "候选 2 人" in steps[0]["detail"]
    ok_step = steps[1]
    assert ok_step["name"] == "generate_contact_profile"
    assert ok_step["detail"] == "张三 — 已更新画像"
    assert ok_step["ok"] is True
    assert ok_step["payload"]["contact_id"] == 1
    assert ok_step["payload"]["model"] == "m1"
    assert "张三" in ok_step["payload"]["output_preview"]
    skip_step = steps[2]
    assert skip_step["detail"] == "李四 — 跳过（7 天内已刷新）"
    assert skip_step["ok"] is None  # 跳过不是失败, 不标 ✗
    assert steps[3]["detail"] == "画像 1 人 · 跳过 1 · 失败 0"


@pytest.mark.asyncio
async def test_batch_with_no_candidates_records_skipped(db):
    """没有候选人也要留痕: 「今天没人需要更新画像」与「今天根本没跑」必须分得开。"""
    stats = await profile.run_profile_batch(
        db_path=db,
        cfg=ContactProfileAgentConfig(row_exists=True, enabled=True),
        now_ms=1_700_000_000_000,
    )
    assert stats["candidates"] == 0
    rows = _runs(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "skipped"
    assert rows[0]["summary"] == "没有待更新画像的联系人"


@pytest.mark.asyncio
async def test_failed_contact_step_is_marked_with_reason(db):
    _seed_contact(db, 1, name="王五")

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
    assert len(rows) == 1 and rows[0]["status"] == "failed"  # 全挂 → failed 不谎报
    steps = list_run_steps(db, int(rows[0]["id"]))
    fail_step = next(s for s in steps if s["kind"] == "tool")
    assert fail_step["ok"] is False
    assert "王五 — 失败" in fail_step["detail"]
    assert "llm down" in fail_step["detail"]


@pytest.mark.asyncio
async def test_batch_level_exception_still_records_and_reraises(db, monkeypatch):
    """选候选人这一步就炸 —— 台账仍落一行 failed + error, 原异常照常上抛。"""
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
    assert rows[0]["status"] == "failed"
    assert "locked" in (rows[0]["error"] or "")


def test_ledger_read_on_db_without_table_is_empty_not_error(tmp_path):
    """老库还没跑到 v73 → 读侧空态, 不抛 (「没这张表」与「还没跑过」的处置一样)。"""
    from src.agents.run_log import count_run_logs, record_agent_run

    bare = tmp_path / "bare.db"
    sqlite3.connect(str(bare)).close()
    assert list_run_logs(str(bare), agent_id=CONTACT_PROFILE_AGENT_ID) == []
    assert count_run_logs(str(bare), agent_id=CONTACT_PROFILE_AGENT_ID) == 0
    assert (
        record_agent_run(
            str(bare), agent_id="a", started_at_ms=1, status="completed"
        )
        is None
    )
