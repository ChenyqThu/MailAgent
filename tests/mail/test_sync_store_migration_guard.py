"""SyncStore 迁移守卫测试 (E0-WP3, task 07-02-e0-safety-net)。

覆盖三条纪律:
1. ALTER/建索引迁移块真失败 → raise SyncStoreMigrationError, db_version **不前进**,
   下次 _init_database 以旧 version 重试 (吞错修正: 旧代码 warning 后无条件 bump,
   真失败永不重试);
2. 版本写入只在全部迁移成功后执行 (由 1 的中断语义保证);
3. 降级守卫: 库 db_version > 代码 DB_VERSION → 拒绝启动 (防旧版 app 降级新库)。

模拟 ALTER 真失败用 __getattr__ 委托代理包住**真实** sqlite3 连接/游标, 仅对目标
SQL 抛**真实** sqlite3.OperationalError (长期记忆坑: monkeypatch 必须用真实类型) ——
其余语句 (PRAGMA 预检/复查、建表) 全部走真库。
"""
from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    SyncStore,
    SyncStoreMigrationError,
    _migration_guard_columns,
    _migration_guard_index,
)


def _db_version(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()
    finally:
        conn.close()
    return int(row[0]) if row else 0


def _set_db_version(db_path: str, version: int) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "UPDATE sync_state SET value=? WHERE key='db_version'", (str(version),)
        )
        conn.commit()
    finally:
        conn.close()


def _columns(db_path: str, table: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    finally:
        conn.close()
    return {r[1] for r in rows}


def _indexes(db_path: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


# ---- 真实类型的失败注入代理 -------------------------------------------------
# 包真实连接/游标, 仅当归一化 SQL 含 fail_sql_substr 时抛真实 OperationalError;
# 其余全部委托真库执行 (PRAGMA 预检/复查、CREATE TABLE、seed 等不受影响)。


class _FailingCursor:
    def __init__(self, real: sqlite3.Cursor, fail_sql_substr: str):
        self._real = real
        self._fail = fail_sql_substr

    def execute(self, sql, *args, **kwargs):
        if self._fail in " ".join(str(sql).split()):
            raise sqlite3.OperationalError("disk I/O error (injected by test)")
        return self._real.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._real, name)


class _FailingConnection:
    def __init__(self, real: sqlite3.Connection, fail_sql_substr: str):
        self._real = real
        self._fail = fail_sql_substr

    def cursor(self):
        return _FailingCursor(self._real.cursor(), self._fail)

    def __getattr__(self, name):
        return getattr(self._real, name)


def _patch_failing_sql(monkeypatch, fail_sql_substr: str) -> None:
    orig = SyncStore._get_connection

    def fake(self):
        return _FailingConnection(orig(self), fail_sql_substr)

    monkeypatch.setattr(SyncStore, "_get_connection", fake)


# ---- 1. ALTER 真失败: version 不前进 + 下次启动重试 ---------------------------


def test_alter_true_failure_no_version_bump_then_retry(tmp_path, monkeypatch):
    """v29 ALTER 真失败 → raise + version 停在 28; 去掉故障后重 init 补齐列 + version 前进。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 先建全 schema (v29)
    # 模拟旧 v28 库: 删 fallback_models_json 列 + 降 version
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("ALTER TABLE report_agent DROP COLUMN fallback_models_json")
        conn.commit()
    finally:
        conn.close()
    _set_db_version(str(db), 28)
    assert "fallback_models_json" not in _columns(str(db), "report_agent")

    _patch_failing_sql(monkeypatch, "ADD COLUMN fallback_models_json")
    with pytest.raises(SyncStoreMigrationError, match="v29 migration"):
        SyncStore(str(db))
    # 真失败被中断: version 不前进 (旧代码这里会 warning + 无条件 bump 到 29)
    assert _db_version(str(db)) == 28
    assert "fallback_models_json" not in _columns(str(db), "report_agent")

    # 故障消失 (monkeypatch 撤销) → 下次启动重试成功
    monkeypatch.undo()
    SyncStore(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert "fallback_models_json" in _columns(str(db), "report_agent")


def test_index_migration_failure_no_version_bump_then_retry(tmp_path, monkeypatch):
    """v20 建唯一索引真失败 → raise + version 停在 19; 重试后索引就位。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("DROP INDEX ux_outbox_pending_intent")
        conn.commit()
    finally:
        conn.close()
    _set_db_version(str(db), 19)
    assert "ux_outbox_pending_intent" not in _indexes(str(db))

    _patch_failing_sql(
        monkeypatch, "CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_pending_intent"
    )
    with pytest.raises(SyncStoreMigrationError, match="ux_outbox_pending_intent"):
        SyncStore(str(db))
    assert _db_version(str(db)) == 19
    assert "ux_outbox_pending_intent" not in _indexes(str(db))

    monkeypatch.undo()
    SyncStore(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert "ux_outbox_pending_intent" in _indexes(str(db))


# ---- 2. 降级守卫 -------------------------------------------------------------


def test_downgrade_guard_refuses_newer_db(tmp_path):
    """库 db_version=99 > 代码 DB_VERSION → 拒绝启动, version 保持 99 不被降级。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    _set_db_version(str(db), 99)

    with pytest.raises(SyncStoreMigrationError) as exc_info:
        SyncStore(str(db))
    # 错误信息带两个版本号 + 指引
    assert "99" in str(exc_info.value)
    assert str(SyncStore.DB_VERSION) in str(exc_info.value)
    # 库未被动过: version 仍是 99
    assert _db_version(str(db)) == 99


def test_downgrade_guard_allows_equal_version(tmp_path):
    """version == DB_VERSION (正常重启) 不触发守卫。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))  # 二次 init: current == DB_VERSION → 正常通过
    assert _db_version(str(db)) == SyncStore.DB_VERSION


# ---- 3. 守卫 helper 的良性分支 (防御性保留) -----------------------------------


def test_guard_helper_benign_when_columns_present(tmp_path):
    """OperationalError 抓到但目标列其实在位 → no-op (不 raise), 维持旧 skip 行为。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        cursor = conn.cursor()
        # fallback_models_json 在位 → 不应 raise
        _migration_guard_columns(
            cursor,
            "report_agent",
            {"fallback_models_json"},
            "v29 migration",
            sqlite3.OperationalError("synthetic"),
        )
        # 索引在位 → 不应 raise
        _migration_guard_index(
            cursor,
            "ux_outbox_pending_intent",
            "v20 migration",
            sqlite3.OperationalError("synthetic"),
        )
    finally:
        conn.close()


def test_guard_helper_raises_when_column_missing(tmp_path):
    """直接单测 helper: 目标列缺失 → raise SyncStoreMigrationError (带原因链)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        cursor = conn.cursor()
        cause = sqlite3.OperationalError("disk I/O error")
        with pytest.raises(SyncStoreMigrationError) as exc_info:
            _migration_guard_columns(
                cursor, "report_agent", {"no_such_column"}, "vX migration", cause
            )
        assert exc_info.value.__cause__ is cause
    finally:
        conn.close()


# ---- 4. 正常迁移路径零回归 -----------------------------------------------------


def test_fresh_init_and_double_init_unaffected(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert "fallback_models_json" in _columns(str(db), "report_agent")
    assert "ux_outbox_pending_intent" in _indexes(str(db))
