"""``run_startup_db_safety(critical=False)``：``library.db`` 进备份清单、不进 quick_check fail-fast。

现有三库的默认档（critical=True）行为不变：坏库 → marker + DbIntegrityError。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from src.mail.db_safety import INTEGRITY_MARKER_FILENAME, DbIntegrityError, run_startup_db_safety


def _make_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT)")
        conn.executemany("INSERT INTO t (payload) VALUES (?)", [("x" * 500,) for _ in range(200)])
        conn.commit()
    finally:
        conn.close()


def _corrupt_header(path: Path) -> None:
    with open(path, "r+b") as f:
        f.seek(0)
        f.write(b"\xde\xad\xbe\xef" * 25)


def test_non_critical_corrupt_db_neither_raises_nor_marks_nor_backs_up(tmp_path):
    db = tmp_path / "library.db"
    _make_db(db)
    _corrupt_header(db)
    marker = tmp_path / INTEGRITY_MARKER_FILENAME
    backups = tmp_path / "backups"
    run_startup_db_safety([db], backups, marker_path=marker, critical=False)  # 不应 raise
    assert not marker.exists()
    assert not list(backups.glob("library-*.db"))  # 坏库不备份


def test_default_stays_critical_for_the_same_corruption(tmp_path):
    db = tmp_path / "sync_store.db"
    _make_db(db)
    _corrupt_header(db)
    marker = tmp_path / INTEGRITY_MARKER_FILENAME
    with pytest.raises(DbIntegrityError):
        run_startup_db_safety([db], tmp_path / "backups", marker_path=marker)
    assert marker.exists()


def test_non_critical_healthy_db_is_still_backed_up(tmp_path):
    db = tmp_path / "library.db"
    _make_db(db)
    backups = tmp_path / "backups"
    run_startup_db_safety([db], backups, critical=False)
    assert len(list(backups.glob("library-*.db"))) == 1


def test_non_critical_run_never_touches_the_critical_marker(tmp_path):
    """非关键库那趟成功了也不能清掉关键库留下的失败 marker（否则 Electron 侧看不到真失败）。"""
    db = tmp_path / "library.db"
    _make_db(db)
    marker = tmp_path / INTEGRITY_MARKER_FILENAME
    marker.write_text('{"failed": [{"db": "sync_store.db"}]}', encoding="utf-8")
    run_startup_db_safety([db], tmp_path / "backups", marker_path=marker, critical=False)
    assert marker.exists()
