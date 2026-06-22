"""/api/agent/skills 管理端点（PR5）—— list / enable-disable / install / uninstall。

fresh_agent_cfg fixture（conftest）给每测试独立临时 agent_config.db。auth bypass on。
"""

from __future__ import annotations


def _skill(skills, name):
    return next((s for s in skills if s["name"] == name), None)


def test_list_skills_resolved(client, fresh_agent_cfg):
    r = client.get("/api/agent/skills")
    assert r.status_code == 200
    skills = r.json()["data"]["skills"]
    email = _skill(skills, "email")
    assert email is not None
    assert email["sourceType"] == "builtin"
    assert email["overridden"] is False
    assert email["enabled"] == email["defaultEnabled"]
    assert email["toolCount"] > 0
    assert "email:read" in email["scopes"]


def test_disable_builtin_skill(client, fresh_agent_cfg):
    r = client.post("/api/agent/skills/email/enabled", json={"enabled": False})
    assert r.status_code == 200
    # GET 反映禁用 + overridden
    email = _skill(client.get("/api/agent/skills").json()["data"]["skills"], "email")
    assert email["enabled"] is False
    assert email["overridden"] is True
    assert email["sourceType"] == "builtin"


def test_enable_unknown_skill_404(client, fresh_agent_cfg):
    r = client.post("/api/agent/skills/nope/enabled", json={"enabled": True})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_enable_bad_body_400(client, fresh_agent_cfg):
    r = client.post("/api/agent/skills/email/enabled", json={"enabled": "yes"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_install_document_skill(client, fresh_agent_cfg):
    r = client.post(
        "/api/agent/skills",
        json={
            "name": "my-notes",
            "sourceType": "document",
            "version": "1.0",
            "manifest": {
                "name": "my-notes",
                "title": "My Notes",
                "description": "notes",
                "version": "1.0",
                "default_enabled": True,
                "prompt_fragment": "Use notes.",
                "tools": [],
            },
        },
    )
    assert r.status_code == 201
    assert r.json()["data"]["name"] == "my-notes"
    # 出现在 list 里（manifest merge）+ sourceType=document
    s = _skill(client.get("/api/agent/skills").json()["data"]["skills"], "my-notes")
    assert s is not None and s["sourceType"] == "document"


def test_install_bad_source_type_400(client, fresh_agent_cfg):
    r = client.post("/api/agent/skills", json={"name": "x", "sourceType": "builtin"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_install_bad_scope_400(client, fresh_agent_cfg):
    r = client.post(
        "/api/agent/skills",
        json={"name": "x", "sourceType": "document", "grantedScopes": ["bogus:scope"]},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_uninstall_skill(client, fresh_agent_cfg):
    client.post(
        "/api/agent/skills",
        json={"name": "gone", "sourceType": "document", "manifest": {"name": "gone", "tools": []}},
    )
    r = client.delete("/api/agent/skills/gone")
    assert r.status_code == 200
    assert r.json()["data"]["removed"] is True
    # 不再出现在 list
    assert _skill(client.get("/api/agent/skills").json()["data"]["skills"], "gone") is None
    # 幂等
    assert client.delete("/api/agent/skills/gone").json()["data"]["removed"] is False
