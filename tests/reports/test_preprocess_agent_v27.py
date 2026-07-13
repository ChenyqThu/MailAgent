"""issue #31/#32 增量2 — AI 邮件预处理 Custom Agent（DB v27）后端契约。

覆盖：v27 迁移（ALTER context_docs_json + 播种 type='preprocess' 行）、幂等、旧库升级、
wire.resolve_agent/config_patch_to_db 的 context_docs/model 往返、运行时 get_preprocess_config。
真临时 SQLite，零 LLM / 零网络。
"""

import json
import sqlite3
from pathlib import Path

import pytest

from src.llm_agent.preprocess_config import PREPROCESS_AGENT_ID, get_preprocess_config
from src.mail.sync_store import SyncStore
from src.reports import wire
from src.reports.store import ReportStore


@pytest.fixture
def db_path(tmp_path: Path) -> str:
    p = str(tmp_path / "sync.db")
    SyncStore(p)  # _init_database → v27 迁移 + 播种
    return p


def test_fresh_db_has_column_and_preprocess_seed(db_path):
    agent = ReportStore(db_path).get_agent(PREPROCESS_AGENT_ID)
    assert agent is not None
    assert agent["type"] == "preprocess"
    assert agent["enabled"] == 0  # 占位（真开关走全局 env）
    assert agent["context_docs_json"] == '["soul", "user"]'
    assert agent["mark_read_after_processing"] == 1


def test_double_init_idempotent(tmp_path):
    p = str(tmp_path / "s.db")
    SyncStore(p)
    SyncStore(p)  # 重跑不炸、不重复播种
    rows = [a for a in ReportStore(p).list_agents() if a["id"] == PREPROCESS_AGENT_ID]
    assert len(rows) == 1


def test_upgrade_from_v26_adds_column_and_seeds(tmp_path):
    """模拟 v26 旧库（无 context_docs_json 列、无 preprocess 行）→ 重 init 应补列 + 播种。"""
    p = str(tmp_path / "old.db")
    SyncStore(p)
    conn = sqlite3.connect(p)
    # 无法可移植 DROP COLUMN → 重建 v26 结构的 report_agent（缺 context_docs_json）。
    conn.execute("DROP TABLE report_agent")
    conn.execute(
        "CREATE TABLE report_agent (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'report', "
        "enabled INTEGER NOT NULL DEFAULT 0, title TEXT, schedule_json TEXT, window_hours INTEGER, "
        "prompt TEXT, model TEXT, tools_json TEXT, kos_enrich INTEGER NOT NULL DEFAULT 0, "
        "trigger_mode TEXT, timezone TEXT, body_full_max INTEGER, body_full_priorities TEXT, "
        "updated_at REAL)"
    )
    conn.execute("UPDATE sync_state SET value='26' WHERE key='db_version'")
    conn.commit()
    conn.close()

    SyncStore(p)  # v27/v29 迁移：current_version=26 < 27/29 → ALTER + seed
    cols = {r[1] for r in sqlite3.connect(p).execute("PRAGMA table_info(report_agent)").fetchall()}
    assert "context_docs_json" in cols
    assert "fallback_models_json" in cols  # v29 ALTER 对旧库同样补齐
    agent = ReportStore(p).get_agent(PREPROCESS_AGENT_ID)
    assert agent is not None
    assert agent["context_docs_json"] == '["soul", "user"]'
    assert agent["fallback_models_json"] is None  # 无 seed 变更：NULL = 跟随全局


def test_resolve_agent_exposes_context_docs(db_path):
    cfg = wire.resolve_agent(ReportStore(db_path).get_agent(PREPROCESS_AGENT_ID))
    assert cfg["type"] == "preprocess"
    assert cfg["context_docs"] == ["soul", "user"]
    assert cfg["prompt"] == ""  # 非 report → 不回填内置默认
    assert cfg["model"] == ""


def test_config_patch_context_docs_and_model_roundtrip(db_path):
    # #8-ext（v1.1.0 dogfood）：预处理模型改走行级 model 列（与 chat 的全局 LLM_MODEL 拆分）。
    store = ReportStore(db_path)
    patch = wire.config_patch_to_db({"context_docs": ["user"], "model": "claude-haiku-4-5"})
    assert json.loads(patch["context_docs_json"]) == ["user"]
    store.update_agent(PREPROCESS_AGENT_ID, patch)
    cfg = wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))
    assert cfg["context_docs"] == ["user"]
    assert cfg["model"] == "claude-haiku-4-5"  # 非 report → 不回填 DEFAULT_REPORT_MODEL


def test_get_preprocess_config_default_seed(db_path):
    pp = get_preprocess_config(db_path)
    assert pp.context_docs == ["soul", "user"]
    assert pp.model == ""  # 种子未设模型 → 跟随全局 LLM_MODEL
    assert pp.fallback_models is None  # v29 种子未设 fallback → 跟随全局 LLM_FALLBACK_MODELS
    assert pp.mark_read_after_processing is True


def test_get_preprocess_config_after_edit(db_path):
    store = ReportStore(db_path)
    store.update_agent(
        PREPROCESS_AGENT_ID,
        wire.config_patch_to_db({"context_docs": [], "model": "  claude-haiku-4-5  "}),
    )
    pp = get_preprocess_config(db_path)
    assert pp.context_docs == []  # 空列表 = 用户显式取消全部注入（≠ None 默认）
    assert pp.model == "claude-haiku-4-5"  # strip


def test_get_preprocess_config_ignores_legacy_persona_prompt(db_path):
    # persona 层已移除：旧行残留 prompt 列值不进入运行时配置（dataclass 无 persona 字段）。
    store = ReportStore(db_path)
    store.update_agent(PREPROCESS_AGENT_ID, {"prompt": "旧 persona 残值"})
    pp = get_preprocess_config(db_path)
    assert not hasattr(pp, "persona")
    assert pp.model == ""


def test_get_preprocess_config_missing_db_graceful(tmp_path):
    pp = get_preprocess_config(str(tmp_path / "nope.db"))
    assert pp.model == ""
    assert pp.context_docs is None  # 缺库 → None → 运行时回退默认文档集
    assert pp.mark_read_after_processing is True


def test_resolve_agent_null_docs_defaults_for_preprocess(db_path):
    # codex MED：NULL context_docs 对 preprocess 投影成默认 ['soul','user']（与 get_preprocess_config
    # 的 None→默认一致），避免 UI 显"未勾选"、保存 persona 时把 docs 覆写成 []→关掉身份注入。
    store = ReportStore(db_path)
    store.update_agent(PREPROCESS_AGENT_ID, {"context_docs_json": None})  # 置 NULL
    cfg = wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))
    assert cfg["context_docs"] == ["soul", "user"]  # NULL → 默认（非 []）


def test_resolve_agent_explicit_empty_docs_preserved(db_path):
    # 用户显式取消全部 → '[]' → 保持 []（非默认），运行时不注入身份文档
    store = ReportStore(db_path)
    store.update_agent(PREPROCESS_AGENT_ID, wire.config_patch_to_db({"context_docs": []}))
    cfg = wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))
    assert cfg["context_docs"] == []


def test_resolve_agent_search_forces_empty_docs(db_path):
    # codex 复审：search 行不用此字段——即使 context_docs_json 有残留值也一律 []。
    # （增量 2 起 report 行改为尊重列值，见下一测试；仅 search 仍强制空。）
    store = ReportStore(db_path)
    store.update_agent("email_search_agent", {"context_docs_json": '["soul"]'})
    cfg = wire.resolve_agent(store.get_agent("email_search_agent"))
    assert cfg["type"] == "search"
    assert cfg["context_docs"] == []


def test_resolve_agent_report_docs_null_defaults_and_respected(db_path):
    # 增量 2：report 行也用 context_docs——NULL（种子行）→ 投影默认 ['soul','user']
    # （与运行时 worker._parse_context_docs 的 None→默认一致）；显式 [] / 列值 → 尊重。
    store = ReportStore(db_path)
    cfg = wire.resolve_agent(store.get_agent("daily_email_digest"))
    assert cfg["type"] == "report"
    assert cfg["context_docs"] == ["soul", "user"]

    store.update_agent("daily_email_digest", wire.config_patch_to_db({"context_docs": []}))
    cfg = wire.resolve_agent(store.get_agent("daily_email_digest"))
    assert cfg["context_docs"] == []

    store.update_agent(
        "daily_email_digest", wire.config_patch_to_db({"context_docs": ["user"]})
    )
    cfg = wire.resolve_agent(store.get_agent("daily_email_digest"))
    assert cfg["context_docs"] == ["user"]


# ─── v29: 行级 fallback 拆分（dogfood R2 #2） ────────────────────────────────


def test_upgrade_from_v28_adds_fallback_column(tmp_path):
    """模拟 v28 旧库（有 context_docs_json、无 fallback_models_json）→ 重 init 应补列，
    既有行留 NULL = 跟随全局（老用户升级零感知）。"""
    p = str(tmp_path / "v28.db")
    SyncStore(p)
    conn = sqlite3.connect(p)
    conn.execute("DROP TABLE report_agent")
    conn.execute(
        "CREATE TABLE report_agent (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'report', "
        "enabled INTEGER NOT NULL DEFAULT 0, title TEXT, schedule_json TEXT, window_hours INTEGER, "
        "prompt TEXT, model TEXT, tools_json TEXT, kos_enrich INTEGER NOT NULL DEFAULT 0, "
        "trigger_mode TEXT, timezone TEXT, body_full_max INTEGER, body_full_priorities TEXT, "
        "updated_at REAL, context_docs_json TEXT)"
    )
    conn.execute(
        "INSERT INTO report_agent (id, type, enabled, context_docs_json) "
        "VALUES ('email_preprocess_agent', 'preprocess', 0, '[\"soul\", \"user\"]')"
    )
    conn.execute("UPDATE sync_state SET value='28' WHERE key='db_version'")
    conn.commit()
    conn.close()

    SyncStore(p)  # v29 迁移：current_version=28 < 29 → ALTER
    cols = {r[1] for r in sqlite3.connect(p).execute("PRAGMA table_info(report_agent)").fetchall()}
    assert "fallback_models_json" in cols
    agent = ReportStore(p).get_agent(PREPROCESS_AGENT_ID)
    assert agent["fallback_models_json"] is None  # 既有行留 NULL
    assert wire.resolve_agent(agent)["fallback_models"] is None  # 投影 = 跟随全局


def test_config_patch_fallback_models_three_state_roundtrip(db_path):
    store = ReportStore(db_path)
    # 种子默认 NULL → 投影 null（跟随全局）
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))["fallback_models"] is None
    # 显式链
    store.update_agent(
        PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": ["m1", "m2"]})
    )
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))["fallback_models"] == [
        "m1",
        "m2",
    ]
    # 显式空 = 不设兜底
    store.update_agent(PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": []}))
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))["fallback_models"] == []
    # None → 落 SQL NULL（从自定义切回跟随全局的路径）
    store.update_agent(PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": None}))
    row = store.get_agent(PREPROCESS_AGENT_ID)
    assert row["fallback_models_json"] is None
    assert wire.resolve_agent(row)["fallback_models"] is None


def test_resolve_agent_non_preprocess_forces_null_fallback(db_path):
    # 镜像 context_docs 的非 preprocess 强制语义：残留列值一律投影 None。
    store = ReportStore(db_path)
    store.update_agent("email_search_agent", {"fallback_models_json": '["m"]'})
    cfg = wire.resolve_agent(store.get_agent("email_search_agent"))
    assert cfg["type"] == "search"
    assert cfg["fallback_models"] is None


def test_get_preprocess_config_fallback_three_states(db_path):
    store = ReportStore(db_path)
    store.update_agent(
        PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": ["fb-a"]})
    )
    assert get_preprocess_config(db_path).fallback_models == ["fb-a"]
    store.update_agent(PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": []}))
    assert get_preprocess_config(db_path).fallback_models == []
    store.update_agent(PREPROCESS_AGENT_ID, wire.config_patch_to_db({"fallback_models": None}))
    assert get_preprocess_config(db_path).fallback_models is None


# ─── v32: 预处理完成后自动标已读（issue #19 owner 决策）──────────────────────


def test_upgrade_from_v31_adds_mark_read_column_and_backfills_true(tmp_path):
    p = str(tmp_path / "v31.db")
    SyncStore(p)
    conn = sqlite3.connect(p)
    old_columns = [
        row[1]
        for row in conn.execute("PRAGMA table_info(report_agent)").fetchall()
        if row[1] != "mark_read_after_processing"
    ]
    column_list = ", ".join(old_columns)
    conn.execute(
        f"CREATE TABLE report_agent_v31 AS SELECT {column_list} FROM report_agent"
    )
    conn.execute("DROP TABLE report_agent")
    conn.execute("ALTER TABLE report_agent_v31 RENAME TO report_agent")
    conn.execute("UPDATE sync_state SET value='31' WHERE key='db_version'")
    conn.commit()
    conn.close()

    SyncStore(p)
    conn = sqlite3.connect(p)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(report_agent)").fetchall()}
        row = conn.execute(
            "SELECT mark_read_after_processing FROM report_agent WHERE id = ?",
            (PREPROCESS_AGENT_ID,),
        ).fetchone()
        version = conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]
    finally:
        conn.close()
    assert "mark_read_after_processing" in cols
    assert row == (1,)
    assert version == str(SyncStore.DB_VERSION)


def test_v32_migration_idempotent(tmp_path):
    p = str(tmp_path / "v32.db")
    SyncStore(p)
    SyncStore(p)
    agent = ReportStore(p).get_agent(PREPROCESS_AGENT_ID)
    assert agent["mark_read_after_processing"] == 1


def test_mark_read_config_roundtrip_and_runtime_hot_read(db_path):
    store = ReportStore(db_path)
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))[
        "mark_read_after_processing"
    ] is True
    store.update_agent(
        PREPROCESS_AGENT_ID,
        wire.config_patch_to_db({"mark_read_after_processing": False}),
    )
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))[
        "mark_read_after_processing"
    ] is False
    assert get_preprocess_config(db_path).mark_read_after_processing is False


def test_mark_read_null_graceful_defaults_true(db_path):
    store = ReportStore(db_path)
    store.update_agent(PREPROCESS_AGENT_ID, {"mark_read_after_processing": None})
    assert wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))[
        "mark_read_after_processing"
    ] is True
    assert get_preprocess_config(db_path).mark_read_after_processing is True
