"""``library.db`` —— 资料库索引库的开库 / 幂等 DDL / 独立版本梯（仿 ``agent_config.db``）。

🔴 **不进全局 ``DB_VERSION``**：本库有自己的 ``library_meta.schema_version``，``CREATE TABLE IF NOT EXISTS``
开库即对齐（design §1.2 D-S1 —— 进 sync_store.db 等于每次改表赌 121s 迁移门控）。

表结构逐字按 design §1.2，外加 §8.2 的多根改动：``library_mount`` 表、``library_file.mount_id``、
唯一键 ``(mount_id, rel_key)``。两张**外部内容** FTS5（porter / trigram）挂在 ``library_text`` 上，
三个 trigger 维护 —— 外部内容表删旧行必须走 ``'delete'`` 特殊命令并给出旧值，否则旧 token 残留。

``library_chunk``（v2）是语义 lane 的向量表：一行一块，``vec`` 是 int8 量化的 1024 维（1 KB），
``source_hash`` 记的是嵌入当时 ``library_text.source_hash`` —— 「这个文件按当前正文嵌过了没有」就靠它，
``model`` 进主键，换模型 = 旧向量被 ``WHERE model=?`` 自然排除，不需要迁移。

连接姿态与 ``MatterRepository`` 同款：per-call 短连接、``BEGIN IMMEDIATE`` 事务、WAL 下并发安全。
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterator, Optional

from src.library.constants import FILE_STATUS, KINDS, MOUNT_MODES, MOUNT_STATUS, SOURCES, TEXT_STATUS

LIBRARY_SCHEMA_VERSION = 2
LIBRARY_DB_FILENAME = "library.db"
LIBRARY_DIRNAME = "library"


def _sql_in(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


# CHECK 词表全部引 constants（零手抄）；改词表 = 改叶子 + parity 闸同批。
_DDL = f"""
CREATE TABLE IF NOT EXISTS library_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS library_mount (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    label     TEXT NOT NULL UNIQUE,
    abs_path  TEXT NOT NULL UNIQUE,
    mode      TEXT NOT NULL CHECK (mode IN ({_sql_in(MOUNT_MODES)})),
    status    TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ({_sql_in(MOUNT_STATUS)})),
    added_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS library_file (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mount_id      INTEGER NOT NULL DEFAULT 0,
    rel_path      TEXT,
    rel_key       TEXT,
    parent_path   TEXT NOT NULL,
    filename      TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ({_sql_in(KINDS)})),
    size_bytes    INTEGER,
    mtime         REAL,
    content_hash  TEXT,
    source        TEXT NOT NULL CHECK (source IN ({_sql_in(SOURCES)})),
    source_ref    TEXT,
    created_by    TEXT,
    status        TEXT NOT NULL DEFAULT 'present' CHECK (status IN ({_sql_in(FILE_STATUS)})),
    text_status   TEXT CHECK (text_status IS NULL OR text_status IN ({_sql_in(TEXT_STATUS)})),
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    UNIQUE (mount_id, rel_key)
);
CREATE INDEX IF NOT EXISTS idx_library_file_folder ON library_file(mount_id, parent_path, status);
CREATE INDEX IF NOT EXISTS idx_library_file_status ON library_file(status);
CREATE TABLE IF NOT EXISTS library_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id          INTEGER NOT NULL,
    old_hash         TEXT,
    new_hash         TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    changed_by       TEXT NOT NULL,
    change_note      TEXT,
    session_id       INTEGER,
    message_id       INTEGER,
    created_at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_history_file ON library_history(file_id, id);
CREATE TABLE IF NOT EXISTS library_text (
    file_id      INTEGER PRIMARY KEY,
    filename     TEXT NOT NULL,
    text_content TEXT NOT NULL,
    extractor    TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    truncated    INTEGER NOT NULL DEFAULT 0,
    extracted_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS library_chunk (
    file_id     INTEGER NOT NULL,
    model       TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    char_start  INTEGER NOT NULL,
    char_end    INTEGER NOT NULL,
    text_hash   TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    vec         BLOB NOT NULL,
    created_at  REAL NOT NULL,
    PRIMARY KEY (file_id, model, idx)
);
CREATE INDEX IF NOT EXISTS idx_library_chunk_model ON library_chunk(model);
CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
    text_content, filename,
    content='library_text', content_rowid='file_id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS library_fts_trigram USING fts5(
    text_content, filename,
    content='library_text', content_rowid='file_id',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS library_fts_insert AFTER INSERT ON library_text BEGIN
    INSERT INTO library_fts(rowid, text_content, filename)
        VALUES (NEW.file_id, NEW.text_content, NEW.filename);
    INSERT INTO library_fts_trigram(rowid, text_content, filename)
        VALUES (NEW.file_id, NEW.text_content, NEW.filename);
END;
CREATE TRIGGER IF NOT EXISTS library_fts_update AFTER UPDATE ON library_text BEGIN
    INSERT INTO library_fts(library_fts, rowid, text_content, filename)
        VALUES ('delete', OLD.file_id, OLD.text_content, OLD.filename);
    INSERT INTO library_fts_trigram(library_fts_trigram, rowid, text_content, filename)
        VALUES ('delete', OLD.file_id, OLD.text_content, OLD.filename);
    INSERT INTO library_fts(rowid, text_content, filename)
        VALUES (NEW.file_id, NEW.text_content, NEW.filename);
    INSERT INTO library_fts_trigram(rowid, text_content, filename)
        VALUES (NEW.file_id, NEW.text_content, NEW.filename);
END;
CREATE TRIGGER IF NOT EXISTS library_fts_delete AFTER DELETE ON library_text BEGIN
    INSERT INTO library_fts(library_fts, rowid, text_content, filename)
        VALUES ('delete', OLD.file_id, OLD.text_content, OLD.filename);
    INSERT INTO library_fts_trigram(library_fts_trigram, rowid, text_content, filename)
        VALUES ('delete', OLD.file_id, OLD.text_content, OLD.filename);
END;
"""


def library_db_for(sync_store_db_path: str) -> str:
    """从 sync_store.db 路径推 library.db（同目录并列，与 agent_config.db 同款）。"""
    return os.path.join(os.path.dirname(os.path.abspath(sync_store_db_path)), LIBRARY_DB_FILENAME)


def library_root_for(sync_store_db_path: str) -> str:
    """库根目录 ``<data>/library/``（与 attachments / compose_staging 同级，随 userData）。"""
    return os.path.join(os.path.dirname(os.path.abspath(sync_store_db_path)), LIBRARY_DIRNAME)


def _sync_store_path(sync_store_db_path: Optional[str]) -> str:
    if sync_store_db_path:
        return sync_store_db_path
    try:
        from src.config import config as _config_singleton

        return _config_singleton.sync_store_db_path
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env：回退 DATA_ROOT
        data_root = os.environ.get("MAILAGENT_DATA_ROOT") or "."
        return os.path.join(os.path.abspath(data_root), "data", "sync_store.db")


def resolve_library_db_path(sync_store_db_path: Optional[str] = None) -> str:
    """library.db 绝对路径：显式 sync_store 同目录 → config 单例同目录 → ``<DATA_ROOT>/data/``。"""
    return library_db_for(_sync_store_path(sync_store_db_path))


def resolve_library_root(sync_store_db_path: Optional[str] = None) -> str:
    return library_root_for(_sync_store_path(sync_store_db_path))


class LibraryDb:
    """只持 db_path；连接 per-op 开关，进程内共享单例零风险。"""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ensure_schema()

    def connect(self) -> sqlite3.Connection:
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(_DDL)
            conn.execute(
                "INSERT OR REPLACE INTO library_meta (key, value) VALUES ('schema_version', ?)",
                (str(LIBRARY_SCHEMA_VERSION),),
            )
            conn.commit()
        finally:
            conn.close()
