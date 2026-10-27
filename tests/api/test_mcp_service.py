"""/api/mcp-service/* —— 设置页「MCP 服务」的 owner 管理接口。

默认 dev bypass（AUTH_DISABLED=true）= owner；鉴权用例自行 monkeypatch AUTH_DISABLED=False。
密钥落在 ``api_key_store`` fixture 的临时 api_auth.db，``/mcp`` 与管理接口读同一份。
"""

from __future__ import annotations

import hashlib

import httpx
import pytest

import src.api.auth as auth_mod
from src.agent_config import store as acstore
from src.security.api_keys import DRAFTER_SCOPES, HANDOFF_SCOPES, READ_ONLY_SCOPES
from src.skills.registry import reset_registry_cache

_BASE = "/api/mcp-service"


def _create(client, label="notion", preset="readonly"):
    r = client.post(f"{_BASE}/keys", json={"label": label, "preset": preset})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _mcp_status(client, plaintext):
    r = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    return r.status_code


# ── 密钥 ─────────────────────────────────────────────────────────────────────


def test_create_returns_plaintext_once_and_list_never_leaks(skill_client, api_key_store):
    data = _create(skill_client)
    plaintext = data["plaintext"]
    assert plaintext.startswith("mak_")
    key = data["key"]
    assert set(key) == {
        "id", "label", "key_prefix", "scopes", "preset", "created_at", "last_used_at",
        "expires_at", "revoked_at", "active",
    }
    assert key["preset"] == "readonly" and key["active"] is True
    assert plaintext.startswith(key["key_prefix"])

    r = skill_client.get(f"{_BASE}/keys")
    assert r.status_code == 200
    text = r.text
    assert plaintext not in text
    assert hashlib.sha256(plaintext.encode()).hexdigest() not in text
    keys = r.json()["data"]["keys"]
    assert [k["id"] for k in keys] == [key["id"]]
    assert "plaintext" not in keys[0] and "key_hash" not in keys[0]


@pytest.mark.parametrize(
    "preset, scopes",
    [("readonly", READ_ONLY_SCOPES), ("handoff", HANDOFF_SCOPES), ("drafter", DRAFTER_SCOPES)],
)
def test_ui_presets_map_to_scopes(skill_client, api_key_store, preset, scopes):
    key = _create(skill_client, preset=preset)["key"]
    assert set(key["scopes"]) == set(scopes)
    assert key["preset"] == preset
    assert set(api_key_store.get_key(key["id"]).scopes) == set(scopes)


def test_custom_scope_key_lists_preset_null(skill_client, api_key_store):
    api_key_store.create_key("cli", scopes=["email:read"])
    keys = skill_client.get(f"{_BASE}/keys").json()["data"]["keys"]
    assert keys[0]["preset"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"label": "x", "preset": "writer"},  # 存在于 KEY_PRESETS，但设置页不提供
        {"label": "x", "preset": "bogus"},
        {"label": "x"},
        {"label": "  ", "preset": "readonly"},
        {"preset": "readonly"},
    ],
)
def test_create_rejects_bad_input(skill_client, api_key_store, body):
    r = skill_client.post(f"{_BASE}/keys", json=body)
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert api_key_store.list_keys() == []


def test_rotate_invalidates_old_plaintext(skill_client, api_key_store, monkeypatch):
    data = _create(skill_client)
    old = data["plaintext"]
    r = skill_client.post(f"{_BASE}/keys/{data['key']['id']}/rotate")
    assert r.status_code == 200, r.text
    new = r.json()["data"]["plaintext"]
    assert new != old
    assert r.json()["data"]["key"]["id"] == data["key"]["id"]
    assert new.startswith(r.json()["data"]["key"]["key_prefix"])

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert _mcp_status(skill_client, old) == 403
    assert _mcp_status(skill_client, new) == 200


def test_revoke_then_mcp_403_and_rotate_404(skill_client, api_key_store, monkeypatch):
    data = _create(skill_client)
    key_id = data["key"]["id"]
    r = skill_client.post(f"{_BASE}/keys/{key_id}/revoke")
    assert r.status_code == 200, r.text
    key = r.json()["data"]["key"]
    assert key["active"] is False and key["revoked_at"] is not None
    assert "plaintext" not in r.json()["data"]

    # 再撤一次幂等
    assert skill_client.post(f"{_BASE}/keys/{key_id}/revoke").status_code == 200
    # 撤销是终态，轮换不复活
    assert skill_client.post(f"{_BASE}/keys/{key_id}/rotate").status_code == 404

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert _mcp_status(skill_client, data["plaintext"]) == 403


def test_unknown_key_404(skill_client, api_key_store):
    assert skill_client.post(f"{_BASE}/keys/nope/rotate").status_code == 404
    assert skill_client.post(f"{_BASE}/keys/nope/revoke").status_code == 404


# ── 鉴权 ─────────────────────────────────────────────────────────────────────


def test_bearer_key_cannot_use_management_api(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    _rec, plaintext = api_key_store.create_key("agent", scopes=list(HANDOFF_SCOPES))
    hdr = {"Authorization": f"Bearer {plaintext}"}
    for method, path, body in [
        ("GET", "/status", None),
        ("GET", "/keys", None),
        ("POST", "/keys", {"label": "evil", "preset": "handoff"}),
        ("GET", "/tools", None),
        ("GET", "/audit", None),
        ("POST", "/probe", {"url": "https://example.com/mcp"}),
    ]:
        r = skill_client.request(method, f"{_BASE}{path}", json=body, headers=hdr)
        assert r.status_code == 401, (method, path, r.text)
    assert len(api_key_store.list_keys()) == 1


def test_local_token_owner_allowed(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "loc-secret")
    r = skill_client.get(f"{_BASE}/keys", headers={auth_mod.LOCAL_TOKEN_HEADER: "loc-secret"})
    assert r.status_code == 200


# ── 状态 ─────────────────────────────────────────────────────────────────────


def test_status_counts_active_and_hot_reads_public_url(
    skill_client, api_key_store, monkeypatch, tmp_path
):
    import src.api.deps as deps

    env_file = tmp_path / ".env"
    env_file.write_text("MAILAGENT_MCP_PUBLIC_URL=https://mcp.example.com/mcp\n")
    monkeypatch.setattr(deps, "get_env_file_path", lambda: str(env_file))
    monkeypatch.setenv("MAILAGENT_API_PORT", "8311")

    _create(skill_client)
    revoked = _create(skill_client, label="old")
    skill_client.post(f"{_BASE}/keys/{revoked['key']['id']}/revoke")

    data = skill_client.get(f"{_BASE}/status").json()["data"]
    assert data == {
        "local_url": "http://127.0.0.1:8311/mcp",
        "public_url": "https://mcp.example.com/mcp",
        "active_key_count": 1,
    }

    env_file.write_text("MAILAGENT_MCP_PUBLIC_URL=https://other.example.com/mcp\n")
    assert skill_client.get(f"{_BASE}/status").json()["data"]["public_url"] == (
        "https://other.example.com/mcp"
    )


# ── 工具清单 ─────────────────────────────────────────────────────────────────


@pytest.fixture()
def installed_collision(tmp_path, monkeypatch):
    """装一个复用 builtin email_get 的 skill：owner 视角会撞名，外部 agent 视角根本看不见它。"""
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    reset_registry_cache()
    acstore.get_agent_config_store().install_skill(
        "email-helper",
        source_type="skill_pack",
        granted_scopes=["email:read"],
        manifest={
            "name": "email-helper",
            "title": "Email Helper",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "",
            "tools": [{"name": "email_get", "bind": "existing"}],
        },
    )
    yield
    acstore.reset_agent_config_store_cache()
    reset_registry_cache()


def test_tools_match_external_agent_view(skill_client, installed_collision):
    r = skill_client.get(f"{_BASE}/tools")
    assert r.status_code == 200, r.text
    tools = {t["name"]: t for t in r.json()["data"]["tools"]}

    # installed skill 不出现 → builtin 不撞名，仍是短名
    assert "mailagent_email_get" in tools
    assert not any("email-helper" in n for n in tools)
    # mcp_exposed=False 的不出现
    assert "mailagent_email_send" not in tools
    assert "mailagent_notion_agent_chat" not in tools

    search = tools["mailagent_email_search"]
    assert set(search) == {"name", "title", "description", "annotations", "auth_scopes", "presets"}
    assert search["title"] == "Search Emails"
    assert search["annotations"]["readOnlyHint"] is True
    assert search["auth_scopes"] == ["email:read"]
    assert search["presets"] == ["readonly", "handoff", "drafter"]
    assert "\n" not in search["description"]

    draft = tools["mailagent_email_draft"]
    assert draft["presets"] == ["drafter"]
    assert draft["annotations"]["readOnlyHint"] is False

    run_now = tools["mailagent_custom_agent_run_now"]
    assert run_now["presets"] == ["handoff"]
    assert run_now["annotations"]["openWorldHint"] is True


def test_first_sentence():
    from src.api.routers.mcp_service import _first_sentence

    assert _first_sentence("Search mail. Returns hits.") == "Search mail."
    assert _first_sentence("Get one email (v1.2) by id.\nMore") == "Get one email (v1.2) by id."
    assert _first_sentence("no period here") == "no period here"


# ── 最近调用 ─────────────────────────────────────────────────────────────────


def test_audit_entries_carry_key_label(skill_client, api_key_store, monkeypatch):
    data = _create(skill_client, label="notion-agent")
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    skill_client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "mailagent_email_search", "arguments": {"q": "redis"}},
        },
        headers={"Authorization": f"Bearer {data['plaintext']}"},
    )
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", True)

    entries = skill_client.get(f"{_BASE}/audit?limit=20").json()["data"]["entries"]
    assert len(entries) == 1
    e = entries[0]
    assert set(e) == {
        "id", "created_at", "key_id", "key_label", "route", "skill", "tool", "status",
        "error_code", "duration_ms",
    }
    assert e["key_label"] == "notion-agent" and e["key_id"] == data["key"]["id"]
    assert (e["route"], e["skill"], e["tool"], e["status"]) == ("/mcp", "search", "email_search", "ok")


def test_audit_limit_bounds(skill_client, api_key_store):
    assert skill_client.get(f"{_BASE}/audit?limit=0").status_code in (400, 422)
    assert skill_client.get(f"{_BASE}/audit?limit=101").status_code in (400, 422)
    assert skill_client.get(f"{_BASE}/audit?limit=100").status_code == 200


# ── 公网地址检测 ─────────────────────────────────────────────────────────────


def _mock_httpx(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(**kwargs):
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


def _probe(client, url="https://mcp.example.com/mcp"):
    r = client.post(f"{_BASE}/probe", json={"url": url})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_probe_reachable(skill_client, monkeypatch):
    _mock_httpx(monkeypatch, lambda req: httpx.Response(405, headers={"Allow": "POST"}))
    assert _probe(skill_client)["result"] == "reachable"


def test_probe_access_blocked_redirect(skill_client, monkeypatch):
    _mock_httpx(
        monkeypatch,
        lambda req: httpx.Response(
            302, headers={"Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login"}
        ),
    )
    data = _probe(skill_client)
    assert data["result"] == "access_blocked"
    assert "302" in data["detail"]


def test_probe_access_blocked_html_page(skill_client, monkeypatch):
    _mock_httpx(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Type": "text/html"}, text="<html>"),
    )
    assert _probe(skill_client)["result"] == "access_blocked"


@pytest.mark.parametrize(
    "handler, detail",
    [
        (lambda req: httpx.Response(404), "HTTP 404"),
        (lambda req: httpx.Response(405), "HTTP 405"),  # 没有 Allow: POST，不是我们的 /mcp
        (lambda req: httpx.Response(302, headers={"Location": "https://elsewhere.test/"}), "HTTP 302"),
    ],
)
def test_probe_unreachable_status(skill_client, monkeypatch, handler, detail):
    _mock_httpx(monkeypatch, handler)
    data = _probe(skill_client)
    assert data == {"result": "unreachable", "detail": detail}


@pytest.mark.parametrize(
    "exc, detail",
    [(httpx.ConnectError, "ConnectError"), (httpx.ReadTimeout, "timeout")],
)
def test_probe_unreachable_on_network_error(skill_client, monkeypatch, exc, detail):
    def fail(req):
        raise exc("boom", request=req)

    _mock_httpx(monkeypatch, fail)
    assert _probe(skill_client) == {"result": "unreachable", "detail": detail}


def test_probe_sends_get_without_following_redirects(skill_client, monkeypatch):
    seen = []

    def handler(req):
        seen.append(req.method)
        return httpx.Response(302, headers={"Location": "https://mcp.example.com/other"})

    _mock_httpx(monkeypatch, handler)
    _probe(skill_client)
    assert seen == ["GET"]


@pytest.mark.parametrize(
    "url",
    [
        "http://mcp.example.com/mcp",
        "ftp://x/mcp",
        "not a url",
        "",
        None,
        "file:///etc/passwd",
        "https://[::1/mcp",  # urlparse 自己抛 ValueError
        "https://\x00x.com/mcp",  # urlparse 放行、httpx 构造 URL 时抛 InvalidURL
    ],
)
def test_probe_rejects_bad_urls(skill_client, monkeypatch, url):
    _mock_httpx(monkeypatch, lambda req: pytest.fail("must not fetch"))
    r = skill_client.post(f"{_BASE}/probe", json={"url": url})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


@pytest.mark.parametrize("url", ["http://localhost:8200/mcp", "http://127.0.0.1:8200/mcp"])
def test_probe_allows_loopback_http(skill_client, monkeypatch, url):
    _mock_httpx(monkeypatch, lambda req: httpx.Response(405, headers={"Allow": "POST"}))
    assert _probe(skill_client, url)["result"] == "reachable"
