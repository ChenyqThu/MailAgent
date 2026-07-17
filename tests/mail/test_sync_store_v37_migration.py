"""SyncStore v37 migration tests — llm_processing 纳入版本化建表 (首启缺表修复)。

背景 (2026-07-17 用户安装反馈): 前端 email:listEnriched 无条件 LEFT JOIN
llm_processing, 但该表此前只由 LLMProcessingStore._ensure_schema() 惰性创建
(LLM_AGENT_ENABLED 默认 false → 永不实例化) → 全新 userData 首启邮件列表
`no such table: llm_processing` 整页崩。v37 起 SyncStore._init_database_impl
无条件 CREATE ... IF NOT EXISTS 建表 + 两索引, DDL 单源 = 模块级常量。

惯例同 v33/v36: 不用 DROP COLUMN (CI sqlite 版本坑); 模拟旧库用 DROP TABLE
(v36 时代的库本就没有这张表, 整表删除即忠实还原)。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore

LLM_COLUMNS = {
    "internal_id",
    "notion_page_id",
    "mailbox",
    "status",
    "retry_count",
    "next_retry_at",
    "last_error",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "latency_ms",
    "labels_json",
    "created_at",
    "updated_at",
}


def _fetchone(db_path: str, sql: str, params=()):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def _table_columns(db_path: str, table: str = "llm_processing") -> set:
    conn = sqlite3.connect(db_path)
    try:
        return {
            row[1]
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
    finally:
        conn.close()


def _index_sqls(db_path: str, table: str = "llm_processing") -> dict:
    """index name → CREATE INDEX sql (sqlite_master 原文)。"""
    conn = sqlite3.connect(db_path)
    try:
        return {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
                (table,),
            ).fetchall()
        }
    finally:
        conn.close()


def test_fresh_db_has_llm_processing(tmp_path):
    """全新库 (首启场景, LLM 关闭): SyncStore init 即建表 + 两索引。"""
    db = str(tmp_path / "fresh.db")
    SyncStore(db)

    assert _table_columns(db) == LLM_COLUMNS
    indexes = _index_sqls(db)
    assert "idx_llm_status" in indexes
    assert "idx_llm_retry" in indexes
    # partial index 谓词必须在 (retry 队列只扫 failed 行)
    assert "status='failed'" in indexes["idx_llm_retry"]
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_v37_creates_table_idempotently(tmp_path):
    """v36 旧库 (无 llm_processing) → 建表; 重复 init 幂等; 版本推进到当前。"""
    db = str(tmp_path / "v37.db")
    SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        # 模拟 v36 时代的库: 表不存在 (索引随表一并消失) + 版本回拨。
        conn.execute("DROP TABLE llm_processing")
        conn.execute("UPDATE sync_state SET value='36' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()

    SyncStore(db)
    SyncStore(db)  # 幂等: 第二次 init 不因表/索引已存在而炸

    assert _table_columns(db) == LLM_COLUMNS
    indexes = _index_sqls(db)
    assert {"idx_llm_status", "idx_llm_retry"} <= set(indexes)
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_ddl_single_source_matches_llm_store(tmp_path):
    """漂移守卫: LLMProcessingStore 单独建的表与 SyncStore 建的逐列/逐索引一致。

    两边引用同一组 DDL 常量 (sync_store.LLM_PROCESSING_TABLE_DDL / _INDEX_DDLS),
    本测试把「共用单源」钉死成行为断言 —— 谁在任一侧改回内联 DDL 造成漂移, 这里红。
    """
    from src.llm_agent.store import LLMProcessingStore

    sync_db = str(tmp_path / "by_sync_store.db")
    llm_db = str(tmp_path / "by_llm_store.db")
    SyncStore(sync_db)
    LLMProcessingStore(db_path=llm_db)

    assert _table_columns(sync_db) == _table_columns(llm_db) == LLM_COLUMNS
    assert _index_sqls(sync_db) == _index_sqls(llm_db)

    # 既有库上再实例化 LLMProcessingStore (双保险路径) 也幂等
    LLMProcessingStore(db_path=sync_db)
    assert _table_columns(sync_db) == LLM_COLUMNS
