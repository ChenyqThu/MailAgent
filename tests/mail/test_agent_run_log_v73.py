"""v73 —— agent_run_log / agent_run_step 统一执行台账 + contact_profile_run 迁入
(task 08-27-l4-tab-workspace P4a run transcript)。

盯六件事:
① 新库满梯子后两张表在, 列集合**逐字**相等 (漏一列 / 多一列都红), 索引在;
② status CHECK = 9 值域 (run_state.AGENT_RUN_STATES) 的**子集**, 拒绝子集外的一切
   —— 包括 9 值域里有但子集里没有的 'queued', 和 v72 的旧词 'ok';
③ kind CHECK 只认 trig|think|tool|out;
④ v72 老库 (有 contact_profile_run + 行) 升级: 行按 ok→completed / noop→skipped /
   fail→failed 搬进 agent_run_log, summary 预生成, 时间列毫秒直搬, 然后表被 DROP;
⑤ v71 老库 (没有 contact_profile_run) 升级不炸; 连开两次幂等且不冲掉既有行;
⑥ 防回: 本组 DDL **不进** CONTACT_*/MATTER_* 既有组 (v52 教训); 值域子集关系钉死。

🔴 全程 tmp_path 建库, 绝不碰 userData / 仓库 data/ 的真实库。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.agents.run_log import AGENT_RUN_LOG_STATUS_VALUES, AGENT_RUN_STEP_KINDS
from src.agents.run_state import AGENT_RUN_STATES
from src.mail.sync_store import (
    AGENT_RUN_LOG_INDEX_DDLS,
    AGENT_RUN_LOG_TABLE_DDLS,
    CONTACT_INDEX_DDLS,
    CONTACT_SUGGESTION_INDEX_DDLS,
    MATTER_INDEX_DDLS,
    MATTER_TABLE_DDLS,
    SyncStore,
    _INITIALIZED_DBS,
)

EXPECTED_RUN_COLUMNS = {
    "id",
    "agent_id",
    "started_at",
    "completed_at",
    "status",
    "trigger_kind",
    "trigger_detail",
    "summary",
    "model",
    "input_tokens",
    "output_tokens",
    "error",
}

EXPECTED_STEP_COLUMNS = {
    "id",
    "run_id",
    "seq",
    "kind",
    "name",
    "detail",
    "payload_json",
    "ok",
    "ms",
    "created_at",
}

EXPECTED_INDEXES = {"idx_agent_run_log_recent", "idx_agent_run_step"}


def _columns(path, table: str) -> set:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _indexes(path) -> set:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name IN ('agent_run_log', 'agent_run_step') "
                "AND name NOT LIKE 'sqlite_%'"
            )
        }


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


_RUN_INSERT = (
    "INSERT INTO agent_run_log (agent_id, started_at, completed_at, status) "
    "VALUES ('a1', 1000, 2000, ?)"
)

_STEP_INSERT = (
    "INSERT INTO agent_run_step (run_id, seq, kind, created_at) VALUES (1, 0, ?, 1000)"
)


# ── ① 新库形状 ─────────────────────────────────────────────────────────────────


def test_v73_fresh_database_has_run_log_tables(tmp_path):
    path = tmp_path / "sync.db"
    store = SyncStore(str(path))
    assert store.DB_VERSION >= 73
    assert _columns(path, "agent_run_log") == EXPECTED_RUN_COLUMNS
    assert _columns(path, "agent_run_step") == EXPECTED_STEP_COLUMNS
    assert EXPECTED_INDEXES <= _indexes(path)
    assert _version(path) == SyncStore.DB_VERSION
    # v72 的表在新库上根本不出现 (它的建表块已随 v73 退役)。
    assert _columns(path, "contact_profile_run") == set()


# ── ② status = 9 值域子集, CHECK 拒绝一切子集外的值 ────────────────────────────


def test_status_vocabulary_is_a_subset_of_the_nine_state_domain():
    """🔴 不发明词表: 需要别的态从 9 值域取, 禁止新增第 10 个值。"""
    assert set(AGENT_RUN_LOG_STATUS_VALUES) <= AGENT_RUN_STATES
    assert set(AGENT_RUN_LOG_STATUS_VALUES) == {
        "running", "completed", "failed", "skipped",
    }


def test_v73_status_check_rejects_values_outside_the_subset(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        for good in AGENT_RUN_LOG_STATUS_VALUES:
            conn.execute(_RUN_INSERT, (good,))
        # 'queued' 在 9 值域里但不在子集里; 'ok' 是 v72 的旧词; 都必须被库这层拦住。
        for bad in ("queued", "paused_pending", "ok", "noop", "fail", "ready"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(_RUN_INSERT, (bad,))
        conn.commit()
        assert (
            conn.execute("SELECT COUNT(*) FROM agent_run_log").fetchone()[0]
            == len(AGENT_RUN_LOG_STATUS_VALUES)
        )


# ── ③ kind CHECK ───────────────────────────────────────────────────────────────


def test_v73_step_kind_check_rejects_unknown_kind(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(_RUN_INSERT, ("completed",))
        for good in AGENT_RUN_STEP_KINDS:
            conn.execute(_STEP_INSERT, (good,))
        for bad in ("log", "step", "output", ""):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(_STEP_INSERT, (bad,))
        conn.commit()
        assert (
            conn.execute("SELECT COUNT(*) FROM agent_run_step").fetchone()[0]
            == len(AGENT_RUN_STEP_KINDS)
        )


# ── ④ v72 老库: 行搬迁 + DROP ──────────────────────────────────────────────────

# v72 的表形状 (原 CONTACT_PROFILE_RUN_TABLE_DDLS, 常量已退役, 这里按当时的 DDL 复刻
# —— 迁移测试必须能在没有旧常量的代码上重现旧库)。
_V72_TABLE = """CREATE TABLE contact_profile_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'fail', 'noop')),
    candidates INTEGER NOT NULL DEFAULT 0,
    ran INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    error TEXT NULL
)"""


def _downgrade_to_v72_with_rows(path) -> None:
    """新库拨回 v72 形态: 建旧表 + 三种 status 各一行 + 清掉 v73 的两张表。"""
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE agent_run_step")
        conn.execute("DROP TABLE agent_run_log")
        conn.execute(_V72_TABLE)
        conn.executemany(
            "INSERT INTO contact_profile_run "
            "(started_at, completed_at, status, candidates, ran, ok_count, "
            "skipped, failed, error) VALUES (?,?,?,?,?,?,?,?,?)",
            [
                (1_700_000_000_000, 1_700_000_090_000, "ok", 5, 5, 4, 0, 1, None),
                (1_700_000_100_000, 1_700_000_100_500, "noop", 0, 0, 0, 0, 0, None),
                (1_700_000_200_000, 1_700_000_200_900, "fail", 4, 1, 0, 0, 1,
                 "database is locked"),
            ],
        )
        conn.execute("UPDATE sync_state SET value='72' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()


def test_v72_to_v73_migrates_rows_and_drops_old_table(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    _downgrade_to_v72_with_rows(path)
    assert _columns(path, "agent_run_log") == set()  # 没这句, 表没删掉本用例也会「通过」

    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM agent_run_log ORDER BY started_at ASC"
        ).fetchall()
    assert len(rows) == 3
    by_status = {r["status"]: r for r in rows}
    # 映射: ok→completed / noop→skipped / fail→failed (与旧读侧词表逐字一致)。
    assert set(by_status) == {"completed", "skipped", "failed"}
    ok_row = by_status["completed"]
    assert ok_row["agent_id"] == "contact_profile_agent"
    # 时间列毫秒直搬, 不换算。
    assert ok_row["started_at"] == 1_700_000_000_000
    assert ok_row["completed_at"] == 1_700_000_090_000
    # summary 按旧读侧 _profile_run_summary 的口径预生成。
    assert ok_row["summary"] == "画像 4 人 · 跳过 0 · 失败 1"
    assert by_status["skipped"]["summary"] == "没有待更新画像的联系人"
    fail_row = by_status["failed"]
    assert fail_row["summary"] == "没跑完 · 候选 4 人，已完成 0 人"
    assert fail_row["error"] == "database is locked"
    # 老表被 DROP —— 退役要退干净。
    assert _columns(path, "contact_profile_run") == set()
    assert _version(path) == SyncStore.DB_VERSION


def test_v71_library_without_profile_run_table_migrates_clean(tmp_path):
    """<v72 的老库从没有 contact_profile_run —— 搬迁块必须探测后跳过, 不许炸。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE agent_run_step")
        conn.execute("DROP TABLE agent_run_log")
        conn.execute("UPDATE sync_state SET value='71' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()

    SyncStore(str(path))
    SyncStore(str(path))  # 连开两次幂等
    assert _columns(path, "agent_run_log") == EXPECTED_RUN_COLUMNS
    assert _columns(path, "agent_run_step") == EXPECTED_STEP_COLUMNS
    assert _version(path) == SyncStore.DB_VERSION


def test_v73_replay_preserves_existing_run_log_rows(tmp_path):
    """幂等重放不冲掉既有台账 (CREATE TABLE IF NOT EXISTS, 搬迁只认 v72 旧表)。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(_RUN_INSERT, ("completed",))
        conn.execute("UPDATE sync_state SET value='72' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()

    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM agent_run_log").fetchone()[0] == 1


# ── ⑥ 防回 ─────────────────────────────────────────────────────────────────────


def test_run_log_ddls_stay_out_of_other_groups():
    """🔴 混进 CONTACT_*/MATTER_* 任一组, 那些组的旧块就会对老库重放本表 (v52 教训)。"""
    joined = " ".join(
        (
            *CONTACT_INDEX_DDLS,
            *CONTACT_SUGGESTION_INDEX_DDLS,
            *MATTER_INDEX_DDLS,
            *MATTER_TABLE_DDLS,
        )
    )
    assert "agent_run_log" not in joined
    assert "agent_run_step" not in joined
    assert all(
        "agent_run_log" in ddl or "agent_run_step" in ddl
        for ddl in AGENT_RUN_LOG_TABLE_DDLS
    )
    assert all(
        "agent_run_log" in ddl or "agent_run_step" in ddl
        for ddl in AGENT_RUN_LOG_INDEX_DDLS
    )
