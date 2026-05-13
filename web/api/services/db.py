"""SQLite 只读连接管理。

使用 ?mode=ro 避免与 MailAgent 主进程 WAL 冲突。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator

from web.api.config import web_config


def _connect_ro(db_path: str) -> sqlite3.Connection:
    """打开只读连接。"""
    path = Path(db_path).resolve()
    conn = sqlite3.connect(
        f"file:{path}?mode=ro",
        uri=True,
        timeout=5.0,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """获取 sync_store.db 只读连接（短事务模式）。"""
    conn = _connect_ro(web_config.sync_store_db_path)
    try:
        yield conn
    finally:
        conn.close()


def _connect_rw(db_path: str) -> sqlite3.Connection:
    """打开读写连接（仅用于 action 等必要写操作）。"""
    path = Path(db_path).resolve()
    conn = sqlite3.connect(
        str(path),
        timeout=10.0,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def get_db_rw() -> Generator[sqlite3.Connection, None, None]:
    """获取 sync_store.db 读写连接（短事务，用完即关）。"""
    conn = _connect_rw(web_config.sync_store_db_path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


_WEB_COLUMNS = [
    ("processing_status", "TEXT"),
    ("web_action_at", "REAL"),
]


def ensure_web_columns() -> None:
    """启动时确保 web 层依赖的列存在（idempotent）。

    当 web 作为独立部署运行时，MailAgent 主进程的 SyncStore 迁移
    可能还没执行过，这里兜底创建 web 需要的列。
    """
    db_path = web_config.sync_store_db_path
    if not Path(db_path).exists():
        return

    conn = _connect_rw(db_path)
    try:
        existing = {
            row[1] for row in conn.execute("PRAGMA table_info(email_metadata)").fetchall()
        }
        for col_name, col_type in _WEB_COLUMNS:
            if col_name not in existing:
                conn.execute(f"ALTER TABLE email_metadata ADD COLUMN {col_name} {col_type}")
        conn.commit()
    finally:
        conn.close()
