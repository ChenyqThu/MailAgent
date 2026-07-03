"""启动期数据库安全网测试 (E0-WP2, task 07-02-e0-safety-net)。

覆盖:
- 损坏库 (头部覆写 / 尾部截断) → quick_check 拦截 → DbIntegrityError + marker 写入
  + 已有备份不轮转不覆盖;
- 健康库 → VACUUM INTO 备份落盘 + 轮转只留 keep 份;
- 24h 节流: 最新备份足够新 → 整个通道跳过 (含 quick_check);
- 成功通过后清除历史失败 marker;
- 备份失败 (backups_dir 不可用) 不阻断启动;
- 库文件不存在 → 跳过。
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from src.mail.db_safety import (
    DbIntegrityError,
    INTEGRITY_MARKER_FILENAME,
    create_backup,
    integrity_failure_marker_path,
    quick_check,
    run_startup_db_safety,
)


def _make_healthy_db(path: Path, rows: int = 200) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT)")
        conn.executemany(
            "INSERT INTO t (payload) VALUES (?)",
            [("x" * 500,) for _ in range(rows)],
        )
        conn.commit()
    finally:
        conn.close()


def _corrupt_header(path: Path) -> None:
    """覆写 SQLite 头 (magic string) → 连接即报 file is not a database。"""
    with open(path, "r+b") as f:
        f.seek(0)
        f.write(b"\xde\xad\xbe\xef" * 25)


def _corrupt_truncate(path: Path) -> None:
    """截断到非页边界 → quick_check 报 malformed。"""
    size = path.stat().st_size
    with open(path, "r+b") as f:
        f.truncate(size - 700)


# ---- quick_check ---------------------------------------------------------


def test_quick_check_ok_on_healthy_db(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    ok, detail = quick_check(db)
    assert ok is True
    assert detail == "ok"


def test_quick_check_fails_on_header_corruption(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    _corrupt_header(db)
    ok, detail = quick_check(db)
    assert ok is False
    assert detail  # 带原因说明


def test_quick_check_fails_on_truncation(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    _corrupt_truncate(db)
    ok, detail = quick_check(db)
    assert ok is False


# ---- 损坏库: 启动被拦 + 已有备份保全 ---------------------------------------


def test_corrupt_db_blocks_startup_and_writes_marker(tmp_path):
    db = tmp_path / "data" / "sync_store.db"
    db.parent.mkdir()
    _make_healthy_db(db)
    _corrupt_header(db)
    backups = tmp_path / "backups"
    marker = integrity_failure_marker_path(db)

    with pytest.raises(DbIntegrityError, match="sync_store.db"):
        run_startup_db_safety([db], backups, marker_path=marker)

    # marker 写入且带失败详情 + 备份目录指引
    assert marker.exists()
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert payload["failed"][0]["db"] == str(db)
    assert payload["failed"][0]["detail"]
    assert payload["backups_dir"] == str(backups)
    # 坏库不产生备份
    assert not backups.exists() or not list(backups.glob("sync_store-*.db"))


def test_corrupt_db_preserves_existing_backups(tmp_path):
    """quick_check 失败时已有好备份**原样保留** (不轮转不覆盖)。"""
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"
    backups.mkdir()
    old = backups / "sync_store-20260101-000000.db"
    old.write_bytes(b"good backup bytes")
    # 备份做旧到 48h 前 → 通道 due, quick_check 真的会跑
    stale = time.time() - 48 * 3600
    os.utime(old, (stale, stale))

    _corrupt_truncate(db)
    with pytest.raises(DbIntegrityError):
        run_startup_db_safety([db], backups, marker_path=tmp_path / INTEGRITY_MARKER_FILENAME)

    assert old.exists()
    assert old.read_bytes() == b"good backup bytes"
    assert list(backups.glob("sync_store-*.db")) == [old]


# ---- 健康库: 备份 + 轮转 ----------------------------------------------------


def test_healthy_db_creates_backup(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"

    run_startup_db_safety([db], backups)

    made = list(backups.glob("sync_store-*.db"))
    assert len(made) == 1
    # 备份本身是可读一致的 SQLite 库
    ok, detail = quick_check(made[0])
    assert ok is True
    conn = sqlite3.connect(str(made[0]))
    try:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 200
    finally:
        conn.close()


def test_rotation_keeps_only_newest_three(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"
    backups.mkdir()
    # 3 份旧备份, mtime 依次做旧 (72h/60h/48h 前) → 新备份后共 4 份, 轮转删最旧 1 份
    olds = []
    for i, hours in enumerate((72, 60, 48)):
        f = backups / f"sync_store-2026010{i + 1}-000000.db"
        f.write_bytes(b"old")
        stale = time.time() - hours * 3600
        os.utime(f, (stale, stale))
        olds.append(f)

    run_startup_db_safety([db], backups, keep=3)

    remaining = sorted(backups.glob("sync_store-*.db"))
    assert len(remaining) == 3
    assert not olds[0].exists()  # 最旧 (72h) 被轮转删除
    assert olds[1].exists() and olds[2].exists()


def test_throttle_skips_when_recent_backup(tmp_path):
    """最新备份 < min_interval_hours → 本次通道整个跳过 (连 quick_check 都不跑)。"""
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"
    backups.mkdir()
    fresh = backups / "sync_store-20260702-000000.db"
    fresh.write_bytes(b"fresh backup")
    # mtime = 现在 → 1h 内

    # 即便库损坏, 节流窗口内也不检 (按设计: 检测延迟上限 = min_interval_hours)
    _corrupt_header(db)
    run_startup_db_safety([db], backups)  # 不应 raise

    assert list(backups.glob("sync_store-*.db")) == [fresh]
    assert fresh.read_bytes() == b"fresh backup"


def test_marker_cleared_after_successful_pass(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"
    marker = tmp_path / INTEGRITY_MARKER_FILENAME
    marker.write_text("{}", encoding="utf-8")  # 历史失败残留

    run_startup_db_safety([db], backups, marker_path=marker)

    assert not marker.exists()
    assert len(list(backups.glob("sync_store-*.db"))) == 1


# ---- 边界: 缺库 / 备份失败不阻断 --------------------------------------------


def test_missing_db_skipped(tmp_path):
    backups = tmp_path / "backups"
    run_startup_db_safety([tmp_path / "not_there.db"], backups)  # 不应 raise
    assert not backups.exists() or not list(backups.iterdir())


def test_backup_failure_does_not_block_startup(tmp_path):
    """backups_dir 不可用 (路径被文件占位) → 备份失败仅告警, 不 raise。"""
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    occupied = tmp_path / "backups"
    occupied.write_text("not a dir", encoding="utf-8")

    run_startup_db_safety([db], occupied)  # 不应 raise


def test_create_backup_cleans_partial_on_failure(tmp_path, monkeypatch):
    """VACUUM INTO 中途失败 → 半成品文件被清掉, 异常上抛 (由调用方降级)。"""
    db = tmp_path / "sync_store.db"
    _make_healthy_db(db)
    backups = tmp_path / "backups"

    real_connect = sqlite3.connect

    class _FailingConn:
        def __init__(self, real):
            self._real = real

        def execute(self, sql, *args, **kwargs):
            if "VACUUM INTO" in str(sql):
                # 先制造半成品再抛真实错误类型
                if args and args[0]:
                    Path(args[0][0]).write_bytes(b"partial")
                raise sqlite3.OperationalError("disk full (injected)")
            return self._real.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._real, name)

    def fake_connect(*args, **kwargs):
        return _FailingConn(real_connect(*args, **kwargs))

    monkeypatch.setattr(sqlite3, "connect", fake_connect)
    with pytest.raises(sqlite3.OperationalError):
        create_backup(db, backups)
    monkeypatch.undo()

    assert not list(backups.glob("sync_store-*.db"))  # 半成品已清


def test_multiple_dbs_all_checked_failures_merged(tmp_path):
    """两库都坏 → 一次上报两个失败 (不是碰到第一个就停)。"""
    db1 = tmp_path / "sync_store.db"
    db2 = tmp_path / "agent_config.db"
    _make_healthy_db(db1)
    _make_healthy_db(db2)
    _corrupt_header(db1)
    _corrupt_truncate(db2)
    marker = tmp_path / INTEGRITY_MARKER_FILENAME

    with pytest.raises(DbIntegrityError) as exc_info:
        run_startup_db_safety([db1, db2], tmp_path / "backups", marker_path=marker)

    msg = str(exc_info.value)
    assert "sync_store.db" in msg and "agent_config.db" in msg
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert len(payload["failed"]) == 2
