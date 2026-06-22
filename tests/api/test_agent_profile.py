"""/api/agent/profile/* 读端点（PR2）—— Standing Context 文档 + 投影 + 历史。

owner-only（auth bypass on）。每个测试用独立临时 agent_config.db（fresh_agent_cfg fixture
覆盖 conftest 的 session 级 env + 重置单例缓存）。
"""

from __future__ import annotations

import pytest

from src.agent_config.store import PROFILE_DOC_NAMES
from src.agent_config.templates import SEED_TEMPLATES


@pytest.fixture()
def fresh_agent_cfg(tmp_path, monkeypatch):
    """每测试一个干净 agent_config.db（覆盖 conftest session env + reset 单例）。"""
    from src.agent_config import store as acstore

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()


def test_list_profile_docs_returns_six(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/docs")
    assert r.status_code == 200
    docs = r.json()["data"]["docs"]
    names = [d["docName"] for d in docs]
    # 4 可编辑 + memory + skills
    assert names == list(PROFILE_DOC_NAMES) + ["memory", "skills"]
    editable = {d["docName"]: d["editable"] for d in docs}
    assert all(editable[n] for n in PROFILE_DOC_NAMES)
    assert editable["memory"] is False and editable["skills"] is False
    # 可编辑文档内容 = seed 模板
    by_name = {d["docName"]: d for d in docs}
    assert by_name["soul"]["content"] == SEED_TEMPLATES["soul"]
    assert by_name["soul"]["contentHash"]  # 非空
    # 投影文档无 hash
    assert by_name["memory"]["contentHash"] is None
    assert "# MEMORY" in by_name["memory"]["content"]
    assert "# SKILLS" in by_name["skills"]["content"]


def test_get_editable_doc(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/docs/rules")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["docName"] == "rules"
    assert d["content"] == SEED_TEMPLATES["rules"]
    assert d["editable"] is True
    assert d["updatedBy"] == "seed"


def test_get_memory_projection(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/docs/memory")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["editable"] is False
    assert "# MEMORY" in d["content"]


def test_get_skills_projection(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/docs/skills")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["editable"] is False
    assert "# SKILLS" in d["content"]
    # 真实 builtin skills 出现在投影里（email 是 builtin）
    assert "`email`" in d["content"]


def test_get_unknown_doc_404(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/docs/bogus")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_history_after_seed(client, fresh_agent_cfg):
    # 先触发 seed（读一次）
    client.get("/api/agent/profile/docs/soul")
    r = client.get("/api/agent/profile/history", params={"docName": "soul"})
    assert r.status_code == 200
    hist = r.json()["data"]["history"]
    assert len(hist) == 1
    assert hist[0]["oldHash"] is None
    assert hist[0]["changedBy"] == "seed"
    assert hist[0]["docName"] == "soul"


def test_history_unknown_docname_400(client, fresh_agent_cfg):
    r = client.get("/api/agent/profile/history", params={"docName": "memory"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
