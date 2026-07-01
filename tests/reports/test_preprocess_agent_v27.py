"""issue #31/#32 增量2 — AI 邮件预处理 Custom Agent（DB v27）后端契约。

覆盖：v27 迁移（ALTER context_docs_json + 播种 type='preprocess' 行）、幂等、旧库升级、
wire.resolve_agent/config_patch_to_db 的 context_docs 往返、运行时 get_preprocess_config。
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

    SyncStore(p)  # v27 迁移：current_version=26 < 27 → ALTER + seed
    cols = {r[1] for r in sqlite3.connect(p).execute("PRAGMA table_info(report_agent)").fetchall()}
    assert "context_docs_json" in cols
    agent = ReportStore(p).get_agent(PREPROCESS_AGENT_ID)
    assert agent is not None
    assert agent["context_docs_json"] == '["soul", "user"]'


def test_resolve_agent_exposes_context_docs(db_path):
    cfg = wire.resolve_agent(ReportStore(db_path).get_agent(PREPROCESS_AGENT_ID))
    assert cfg["type"] == "preprocess"
    assert cfg["context_docs"] == ["soul", "user"]
    assert cfg["prompt"] == ""  # 非 report → 不回填内置默认
    assert cfg["model"] == ""


def test_config_patch_context_docs_and_persona_roundtrip(db_path):
    store = ReportStore(db_path)
    patch = wire.config_patch_to_db({"context_docs": ["user"], "prompt": "只标紧急邮件"})
    assert json.loads(patch["context_docs_json"]) == ["user"]
    store.update_agent(PREPROCESS_AGENT_ID, patch)
    cfg = wire.resolve_agent(store.get_agent(PREPROCESS_AGENT_ID))
    assert cfg["context_docs"] == ["user"]
    assert cfg["prompt"] == "只标紧急邮件"
    assert cfg["prompt_is_default"] is False


def test_get_preprocess_config_default_seed(db_path):
    pp = get_preprocess_config(db_path)
    assert pp.context_docs == ["soul", "user"]
    assert pp.persona == ""


def test_get_preprocess_config_after_edit(db_path):
    store = ReportStore(db_path)
    store.update_agent(
        PREPROCESS_AGENT_ID,
        wire.config_patch_to_db({"context_docs": [], "prompt": "  优先看发件人  "}),
    )
    pp = get_preprocess_config(db_path)
    assert pp.context_docs == []  # 空列表 = 用户显式取消全部注入（≠ None 默认）
    assert pp.persona == "优先看发件人"  # strip


def test_get_preprocess_config_missing_db_graceful(tmp_path):
    pp = get_preprocess_config(str(tmp_path / "nope.db"))
    assert pp.persona == ""
    assert pp.context_docs is None  # 缺库 → None → 运行时回退默认文档集


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
