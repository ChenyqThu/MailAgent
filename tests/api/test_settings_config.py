"""serve-api settings 路由测试 — /api/notion-agent/* + /api/settings/* + /api/prompts/*
(task 06-08-chat 第二波 — 远程 config P0+P1)。

镜像本地 IPC notionAgent:getConfig/listModels/listAgents + settings:secrets:status/get +
prompts:list/read 的形状 + 鉴权 + graceful（缺文件 → configured:false / [] / content:''）。
fixtures mock account.json / models.json / .env / prompt 文件；agents list mock subprocess。
auth bypass 默认 ON（tests/api/conftest）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

import src.api.routers.settings as settings_router
from src.api.app import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ============================================================
# notion-agent/config
# ============================================================
def _write_account(path: Path, **fields: object) -> None:
    path.write_text(json.dumps(fields), encoding="utf-8")


def test_notion_agent_config_configured(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """account.json 可读 + token_v2 在位 → configured:true，字段映射正确，token 不返值。"""
    acct = tmp_path / "notion_account.json"
    _write_account(
        acct,
        token_v2="secret-cookie-DO-NOT-LEAK",
        user_name="Lucien",
        user_email="lucien@example.com",
        space_name="ENBU",
        space_id="sp-1",
        agent_name="Mail Agent",
        agent_context_page_id="page-abc",
        agent_accessory="📧",
        default_model="opus-4.8",
        timezone="Asia/Shanghai",
    )
    monkeypatch.setattr(settings_router, "_ACCOUNT_PATH", str(acct))
    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/usr/bin/notion-agent")

    r = client.get("/api/notion-agent/config")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["configured"] is True
    assert data["tokenPresent"] is True
    assert data["userName"] == "Lucien"
    assert data["userEmail"] == "lucien@example.com"
    assert data["spaceName"] == "ENBU"
    assert data["agentName"] == "Mail Agent"
    assert data["agentPageId"] == "page-abc"  # ← agent_context_page_id
    assert data["agentAccessory"] == "📧"
    assert data["defaultModel"] == "opus-4.8"  # ← default_model
    assert data["timezone"] == "Asia/Shanghai"
    assert data["accountPath"] == str(acct)
    assert data["cliPath"] == "/usr/bin/notion-agent"
    # token_v2 value must NEVER appear in the response.
    assert "secret-cookie-DO-NOT-LEAK" not in r.text
    assert "token_v2" not in data


def test_notion_agent_config_missing_account_not_configured(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """account.json 缺失 → configured:false，never throw（200）。"""
    monkeypatch.setattr(settings_router, "_ACCOUNT_PATH", str(tmp_path / "nope.json"))
    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    r = client.get("/api/notion-agent/config")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["configured"] is False
    assert data["tokenPresent"] is False
    assert data["userName"] is None


def test_notion_agent_config_garbled_account_not_configured(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """account.json 非法 JSON → configured:false，never throw。"""
    acct = tmp_path / "notion_account.json"
    acct.write_text("{not valid json", encoding="utf-8")
    monkeypatch.setattr(settings_router, "_ACCOUNT_PATH", str(acct))
    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    r = client.get("/api/notion-agent/config")
    assert r.status_code == 200
    assert r.json()["data"]["configured"] is False


def test_notion_agent_config_account_without_token_not_configured(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """account.json 可读但无 token_v2 → configured:false（但 userName 仍回填）。"""
    acct = tmp_path / "notion_account.json"
    _write_account(acct, user_name="Lucien")  # no token_v2
    monkeypatch.setattr(settings_router, "_ACCOUNT_PATH", str(acct))
    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    r = client.get("/api/notion-agent/config")
    data = r.json()["data"]
    assert data["configured"] is False
    assert data["tokenPresent"] is False
    assert data["userName"] == "Lucien"


# ============================================================
# notion-agent/models
# ============================================================
def test_notion_agent_models(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """models.json friendly_aliases keys → string[]。"""
    models = tmp_path / "models.json"
    models.write_text(
        json.dumps({"friendly_aliases": {"opus-4.8": "id1", "sonnet-4.6": "id2"}, "updated_at": 1}),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_router, "_MODELS_PATH", str(models))
    r = client.get("/api/notion-agent/models")
    assert r.status_code == 200
    assert r.json()["data"] == ["opus-4.8", "sonnet-4.6"]


def test_notion_agent_models_missing_empty(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """models.json 缺失 → []（picker 无 preset）。"""
    monkeypatch.setattr(settings_router, "_MODELS_PATH", str(tmp_path / "nope.json"))
    r = client.get("/api/notion-agent/models")
    assert r.status_code == 200
    assert r.json()["data"] == []


# ============================================================
# notion-agent/agents (spawn CLI)
# ============================================================
class _FakeProc:
    """mock asyncio subprocess —— communicate() 返预设 (stdout, stderr)。"""

    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> None:
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr

    def kill(self) -> None:  # pragma: no cover — timeout 路径才用
        pass

    async def wait(self) -> int:  # pragma: no cover
        return self.returncode


def test_notion_agent_agents_list(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """notion-agent agents list --json → NotionAgentListItem[]。"""
    agents = [
        {
            "agent_id": "a1",
            "name": "Mail Agent",
            "agent_page_id": "pg1",
            "description": "desc",
            "icon": "📧",
        }
    ]
    fake = _FakeProc(json.dumps(agents).encode("utf-8"))

    async def _fake_exec(*_args: object, **_kwargs: object) -> _FakeProc:
        return fake

    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    r = client.get("/api/notion-agent/agents")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["agent_id"] == "a1"
    assert data[0]["name"] == "Mail Agent"


def test_notion_agent_agents_not_installed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CLI 不存在（FileNotFoundError）→ E_NOTION_AGENT_NOT_INSTALLED。"""

    async def _raise_fnf(*_args: object, **_kwargs: object) -> _FakeProc:
        raise FileNotFoundError("notion-agent")

    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _raise_fnf)
    r = client.get("/api/notion-agent/agents")
    assert r.json()["error"]["code"] == "E_NOTION_AGENT_NOT_INSTALLED"


def test_notion_agent_agents_exit_127(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CLI exit 127 + 无 stdout → E_NOTION_AGENT_NOT_INSTALLED。"""
    fake = _FakeProc(b"", b"command not found", returncode=127)

    async def _fake_exec(*_args: object, **_kwargs: object) -> _FakeProc:
        return fake

    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    r = client.get("/api/notion-agent/agents")
    assert r.json()["error"]["code"] == "E_NOTION_AGENT_NOT_INSTALLED"


def test_notion_agent_agents_bad_json(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CLI 输出非法 JSON → E_NOTION_AGENT_AGENTS。"""
    fake = _FakeProc(b"not json at all", returncode=0)

    async def _fake_exec(*_args: object, **_kwargs: object) -> _FakeProc:
        return fake

    monkeypatch.setattr(settings_router, "_resolve_notion_agent_bin", lambda: "/x/notion-agent")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    r = client.get("/api/notion-agent/agents")
    assert r.json()["error"]["code"] == "E_NOTION_AGENT_AGENTS"


# ============================================================
# settings/secrets-status (.env)
# ============================================================
def test_secrets_status_all_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """4 env 全配 → 4 boolean true。"""
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "cli-key")
    monkeypatch.setenv("LLM_API_KEY", "llm-key")
    monkeypatch.setenv("LLM_TRANSLATE_API_KEY", "tr-key")
    monkeypatch.setenv("CUSTOM_API_KEY", "custom-key")
    r = client.get("/api/settings/secrets-status")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data == {
        "cliApiKey": True,
        "llmApiKey": True,
        "llmTranslateApiKey": True,
        "customApiKey": True,
    }
    # status only — secret VALUES never returned.
    assert "cli-key" not in r.text


def test_secrets_status_mixed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """部分配置 / 空值 → 对应 boolean。空字符串 / 全空白算未配置。"""
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "cli-key")
    monkeypatch.setenv("LLM_API_KEY", "")  # empty → false
    monkeypatch.setenv("LLM_TRANSLATE_API_KEY", "   ")  # whitespace → false
    monkeypatch.delenv("CUSTOM_API_KEY", raising=False)  # unset → false
    r = client.get("/api/settings/secrets-status")
    data = r.json()["data"]
    assert data["cliApiKey"] is True
    assert data["llmApiKey"] is False
    assert data["llmTranslateApiKey"] is False
    assert data["customApiKey"] is False


# ============================================================
# settings (persistent, read-only)
# ============================================================
def test_get_settings_payload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """PersistentSettings 形状：userEmail 从 config，其余只读默认。"""

    class _StubConfig:
        user_email = "owner@example.com"

    monkeypatch.setattr("src.api.deps.get_settings", lambda: _StubConfig())
    monkeypatch.delenv("CUSTOM_API_ENDPOINT", raising=False)
    r = client.get("/api/settings")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["userEmail"] == "owner@example.com"
    assert data["dbPath"] is None
    assert data["attachmentDir"] is None
    assert data["pollIntervalSec"] == 5
    assert data["notionAgentPageId"] is None
    assert data["customApiEndpoint"] is None
    assert data["autoDownloadUpdates"] is True


def test_get_settings_custom_endpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CUSTOM_API_ENDPOINT env → customApiEndpoint。"""

    class _StubConfig:
        user_email = "owner@example.com"

    monkeypatch.setattr("src.api.deps.get_settings", lambda: _StubConfig())
    monkeypatch.setenv("CUSTOM_API_ENDPOINT", "https://crs.example")
    r = client.get("/api/settings")
    assert r.json()["data"]["customApiEndpoint"] == "https://crs.example"


# ============================================================
# prompts
# ============================================================
@pytest.fixture
def prompt_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """data root + prompts/ 目录，monkeypatch _resolve_data_root 指向它。"""
    (tmp_path / "prompts").mkdir()
    monkeypatch.setattr("src.config._resolve_data_root", lambda: str(tmp_path))
    return tmp_path


def test_prompts_list(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """两 slot 路径 + exists（inbox 存在，sent 不存在）。"""
    monkeypatch.delenv("LLM_INBOX_PROMPT_PATH", raising=False)
    monkeypatch.delenv("LLM_SENT_PROMPT_PATH", raising=False)
    (prompt_root / "prompts" / "email_inbox.md").write_text("inbox body", encoding="utf-8")
    r = client.get("/api/prompts")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["inbox"]["slot"] == "inbox"
    assert data["inbox"]["exists"] is True
    assert data["inbox"]["path"].endswith("prompts/email_inbox.md")
    assert data["sent"]["exists"] is False


def test_prompts_read_existing(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """读已存在 prompt → content。"""
    monkeypatch.delenv("LLM_INBOX_PROMPT_PATH", raising=False)
    (prompt_root / "prompts" / "email_inbox.md").write_text("inbox prompt content", encoding="utf-8")
    r = client.get("/api/prompts/inbox")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["exists"] is True
    assert data["content"] == "inbox prompt content"


def test_prompts_read_missing(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """读缺失 prompt → content:''（exists:false），never 500。"""
    monkeypatch.delenv("LLM_SENT_PROMPT_PATH", raising=False)
    r = client.get("/api/prompts/sent")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["exists"] is False
    assert data["content"] == ""


def test_prompts_read_invalid_slot(client: TestClient, prompt_root: Path) -> None:
    """非法 slot → E_INVALID_ARG。"""
    r = client.get("/api/prompts/bogus")
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_prompts_env_override(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LLM_INBOX_PROMPT_PATH env override（相对 data root）生效。"""
    (prompt_root / "custom").mkdir()
    (prompt_root / "custom" / "my_inbox.md").write_text("custom inbox", encoding="utf-8")
    monkeypatch.setenv("LLM_INBOX_PROMPT_PATH", "custom/my_inbox.md")
    r = client.get("/api/prompts/inbox")
    data = r.json()["data"]
    assert data["path"].endswith("custom/my_inbox.md")
    assert data["content"] == "custom inbox"


def test_prompts_path_escape_rejected(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LLM_*_PROMPT_PATH 逃逸 data root → E_PATH_ESCAPE（防读任意文件）。"""
    monkeypatch.setenv("LLM_INBOX_PROMPT_PATH", "../../../../etc/passwd")
    r = client.get("/api/prompts/inbox")
    assert r.json()["error"]["code"] == "E_PATH_ESCAPE"


# ============================================================
# auth
# ============================================================
def test_endpoints_require_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """auth bypass 关掉 + 无 token → 401（对齐其它端点）。"""
    monkeypatch.setattr("src.api.auth.AUTH_DISABLED", False)
    with TestClient(app, raise_server_exceptions=False) as c:
        for path in (
            "/api/notion-agent/config",
            "/api/notion-agent/models",
            "/api/settings/secrets-status",
            "/api/settings",
            "/api/prompts",
            "/api/prompts/inbox",
        ):
            assert c.get(path).status_code == 401, path
