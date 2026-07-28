"""serve-api settings 路由测试 — /api/notion-agent/* + /api/settings/* + /api/prompts/*
(task 06-08-chat 第二波 — 远程 config P0+P1)。

镜像本地 IPC notionAgent:getConfig/listModels/listAgents + settings:secrets:status/get +
prompts:read 的形状 + 鉴权 + graceful（缺文件 → configured:false / [] / content:''）。
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
# .env merged read — serve-api does NOT load_dotenv (codex HIGH)
# ============================================================
# serve-api reads .env via pydantic env_file but never injects os.environ. These
# tests put values ONLY in a .env file (via MAILAGENT_ENV_FILE) and DO NOT
# setenv the business keys → simulate the real remote serve-api: value lives in
# the file, not in os.environ. _load_env_merged must still surface them.
def _clear_business_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure tested keys are absent from os.environ so the .env file is the
    only source (real repo .env / shell exports don't mask the assertion).

    Hermetic against ambient os.environ pollution: ``_load_env_merged`` layers
    ``os.environ`` OVER the .env file (shell exports win, mirroring pydantic
    precedence), so ANY managed key present in os.environ — exported in the dev
    shell, or leaked by another test's module-level ``os.environ.setdefault``
    (e.g. tests/mail/test_expansion_loop.py seeds USER_EMAIL/NOTION_TOKEN under
    test reordering) — would override the file value and break the env-snapshot
    assertions. Clear the FULL managed-key set (the exact keys ``_build_env_snapshot``
    surfaces) plus the extra non-managed business keys the secrets-status tests
    null out, so the .env file is the sole contributor regardless of run order.
    """
    extra = (
        "CUSTOM_API_KEY",
        "CUSTOM_API_ENDPOINT",
        "LLM_INBOX_PROMPT_PATH",
        "LLM_SENT_PROMPT_PATH",
    )
    for k in (*settings_router._MANAGED_ENV_KEYS, *extra):
        monkeypatch.delenv(k, raising=False)


def test_secrets_status_reads_env_file_only(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Secrets present ONLY in the .env file (not os.environ) → status true.

    Mirrors serve-api: no load_dotenv, so os.environ.get() alone would read
    false. _load_env_merged(dotenv_values(env_file)) must surface them.
    """
    _clear_business_env(monkeypatch)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "MAILAGENT_CLI_API_KEY=cli-from-file\n"
        "LLM_API_KEY=llm-from-file\n"
        # LLM_TRANSLATE_API_KEY / CUSTOM_API_KEY intentionally absent → false
        "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(env_file))
    r = client.get("/api/settings/secrets-status")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data == {
        "cliApiKey": True,
        "llmApiKey": True,
        "llmTranslateApiKey": False,
        "customApiKey": False,
    }
    # status only — file VALUES never leak into the response.
    assert "cli-from-file" not in r.text


def test_secrets_status_os_environ_overrides_env_file(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """os.environ wins over .env file (pydantic precedence): a shell export of
    empty string masks a configured file value → false."""
    _clear_business_env(monkeypatch)
    env_file = tmp_path / ".env"
    env_file.write_text("LLM_API_KEY=llm-from-file\n", encoding="utf-8")
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(env_file))
    monkeypatch.setenv("LLM_API_KEY", "")  # shell export empty → overrides file
    r = client.get("/api/settings/secrets-status")
    assert r.json()["data"]["llmApiKey"] is False


def test_settings_custom_endpoint_from_env_file(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CUSTOM_API_ENDPOINT present ONLY in .env file → customApiEndpoint surfaced.

    CUSTOM_API_ENDPOINT is NOT a config.py field, so get_settings() cfg can't
    carry it — must come from the merged env_file read.
    """
    _clear_business_env(monkeypatch)

    class _StubConfig:
        user_email = "owner@example.com"

    monkeypatch.setattr("src.api.deps.get_settings", lambda: _StubConfig())
    env_file = tmp_path / ".env"
    env_file.write_text("CUSTOM_API_ENDPOINT=https://crs.from-file\n", encoding="utf-8")
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(env_file))
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["data"]["customApiEndpoint"] == "https://crs.from-file"


def test_prompts_env_override_from_env_file(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LLM_INBOX_PROMPT_PATH override present ONLY in .env file (not os.environ)
    → resolved + read. Data root = same tmp_path so the override stays clamped."""
    _clear_business_env(monkeypatch)
    (tmp_path / "prompts").mkdir()
    (tmp_path / "custom").mkdir()
    (tmp_path / "custom" / "from_file.md").write_text("inbox via env_file", encoding="utf-8")
    monkeypatch.setattr("src.config._resolve_data_root", lambda: str(tmp_path))
    env_file = tmp_path / ".env"
    env_file.write_text("LLM_INBOX_PROMPT_PATH=custom/from_file.md\n", encoding="utf-8")
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(env_file))
    r = client.get("/api/prompts/inbox")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["path"].endswith("custom/from_file.md")
    assert data["content"] == "inbox via env_file"


def test_load_env_merged_graceful_when_env_file_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Missing env_file → falls back to plain os.environ (never raises)."""
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(tmp_path / "does-not-exist.env"))
    monkeypatch.setenv("SOME_PROBE_KEY", "probe-value")
    merged = settings_router._load_env_merged()
    assert merged.get("SOME_PROBE_KEY") == "probe-value"


# ============================================================
# env snapshot (GET /api/env — managed .env, read-only)
# ============================================================
def test_env_snapshot_shape_and_redaction(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """EnvSnapshot 形状：path/exists/values/managedKeys/secretKeys。secret 脱敏，
    非 secret 原值，非受管 key 不出现在 values。"""
    _clear_business_env(monkeypatch)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "USER_EMAIL=owner@example.com\n"  # managed, non-secret → plaintext
        "NOTION_TOKEN=secret-token-DO-NOT-LEAK\n"  # managed secret → '***'
        "DASHBOARD_PASSWORD=\n"  # managed secret, empty → ''
        # codex r4 [HIGH] — credential-bearing URLs: managed (returned) but
        # redacted, so the embedded token / password never crosses the wire.
        "ALERT_FEISHU_WEBHOOK_URL=https://open.feishu.cn/hook/feishu-token-DO-NOT-LEAK\n"
        "REDIS_URL=redis://:redis-pass-DO-NOT-LEAK@host:6379\n"
        "SOME_UNMANAGED_KEY=should-not-leak\n"  # not managed → absent from values
        "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(env_file))
    r = client.get("/api/env")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["exists"] is True
    assert data["path"].endswith(".env")
    # managedKeys / secretKeys echoed.
    assert "NOTION_TOKEN" in data["managedKeys"]
    assert "USER_EMAIL" in data["managedKeys"]
    assert "NOTION_TOKEN" in data["secretKeys"]
    assert "USER_EMAIL" not in data["secretKeys"]
    # values: non-secret plaintext, secret redacted, empty secret '', unmanaged absent.
    assert data["values"]["USER_EMAIL"] == "owner@example.com"
    assert data["values"]["NOTION_TOKEN"] == "***"
    assert data["values"]["DASHBOARD_PASSWORD"] == ""
    assert "SOME_UNMANAGED_KEY" not in data["values"]
    # codex r4 [HIGH] — credential URLs returned but redacted to '***'.
    assert data["values"]["ALERT_FEISHU_WEBHOOK_URL"] == "***"
    assert data["values"]["REDIS_URL"] == "***"
    # plaintext secret + unmanaged value NEVER cross the wire.
    assert "secret-token-DO-NOT-LEAK" not in r.text
    assert "should-not-leak" not in r.text
    # codex r4 [HIGH] — the embedded webhook token / redis password must not leak.
    assert "feishu-token-DO-NOT-LEAK" not in r.text
    assert "redis-pass-DO-NOT-LEAK" not in r.text


def test_env_snapshot_missing_file_graceful(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """缺 .env → exists:false / values:{}（never throw），managedKeys 照常返回。"""
    _clear_business_env(monkeypatch)
    monkeypatch.setenv("MAILAGENT_ENV_FILE", str(tmp_path / "nope.env"))
    r = client.get("/api/env")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["exists"] is False
    assert data["values"] == {}
    assert len(data["managedKeys"]) > 0
    assert len(data["secretKeys"]) > 0


def test_env_snapshot_managed_secret_keys_match_ts() -> None:
    """受管 / secret key 数量与 TS SSoT 对齐（防漂移：env-keys.ts 改了这里也要改）。"""
    snap = settings_router._build_env_snapshot()
    # SECRET_ENV_KEYS in env-keys.ts has exactly 15 entries (codex r4 [HIGH]
    # added ALERT_FEISHU_WEBHOOK_URL + REDIS_URL; KOS Settings added
    # KOS_OAUTH_CLIENT_SECRET — gbrain OAuth secret written by IntegrationsTab;
    # Web search added TAVILY_API_KEY — Tavily search key written by IntegrationsTab;
    # issue #64's MAILAGENT_BULK_CLIENT_SECRET was TS-only until the parity gate
    # caught it). 这个手写数字只是粗筛 —— 真正的两侧对账在
    # tests/config/test_managed_env_keys_parity.py（集合相等，不是计数）。
    assert len(snap["secretKeys"]) == 15
    # KOS OAuth secret: MANAGED (writable from Settings) but SECRET (redacted on read).
    assert "KOS_OAUTH_CLIENT_SECRET" in snap["secretKeys"]
    assert "KOS_OAUTH_CLIENT_SECRET" in snap["managedKeys"]
    # Tavily search key: MANAGED (writable from Settings) but SECRET (redacted on read).
    assert "TAVILY_API_KEY" in snap["secretKeys"]
    assert "TAVILY_API_KEY" in snap["managedKeys"]
    # codex r4 [HIGH] — the two credential URLs are MANAGED (returned) but must
    # be SECRET (redacted). Assert they're in both sets so they never leak.
    assert "ALERT_FEISHU_WEBHOOK_URL" in snap["secretKeys"]
    assert "ALERT_FEISHU_WEBHOOK_URL" in snap["managedKeys"]
    assert "REDIS_URL" in snap["secretKeys"]
    assert "REDIS_URL" in snap["managedKeys"]
    # All secret keys must be a subset of managed keys.
    assert set(snap["secretKeys"]).issubset(set(snap["managedKeys"]))
    # No duplicate managed keys.
    assert len(snap["managedKeys"]) == len(set(snap["managedKeys"]))


# ============================================================
# prompts
# ============================================================
@pytest.fixture
def prompt_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """data root + prompts/ 目录，monkeypatch _resolve_data_root 指向它。"""
    (tmp_path / "prompts").mkdir()
    monkeypatch.setattr("src.config._resolve_data_root", lambda: str(tmp_path))
    return tmp_path


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
# prompts write (PUT /api/prompts/{slot} — v1.3.0 预处理抽屉 prompt 可编辑)
# ============================================================
def test_prompts_write_existing(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """覆写已存在 prompt → 落盘 + 返回 PromptInfo（exists:true），读回新内容。"""
    monkeypatch.delenv("LLM_INBOX_PROMPT_PATH", raising=False)
    target = prompt_root / "prompts" / "email_inbox.md"
    target.write_text("old body", encoding="utf-8")
    r = client.put("/api/prompts/inbox", json={"content": "new inbox prompt"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["slot"] == "inbox"
    assert data["exists"] is True
    assert data["path"].endswith("prompts/email_inbox.md")
    assert target.read_text(encoding="utf-8") == "new inbox prompt"


def test_prompts_write_creates_missing_file_and_dir(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """目标文件（含父目录）不存在 → mkdir -p + 创建（镜像 prompts.ts writePrompt）。"""
    (prompt_root / "prompts").rmdir()  # fixture 建的空目录，连目录一起缺
    monkeypatch.delenv("LLM_SENT_PROMPT_PATH", raising=False)
    r = client.put("/api/prompts/sent", json={"content": "sent prompt"})
    assert r.status_code == 200
    assert r.json()["data"]["exists"] is True
    assert (prompt_root / "prompts" / "email_sent.md").read_text(encoding="utf-8") == "sent prompt"


def test_prompts_write_invalid_slot(client: TestClient, prompt_root: Path) -> None:
    """非法 slot → E_INVALID_ARG。"""
    r = client.put("/api/prompts/bogus", json={"content": "x"})
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_prompts_write_non_string_content(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """content 缺失 / 非字符串 → E_INVALID_ARG（不落盘）。"""
    monkeypatch.delenv("LLM_INBOX_PROMPT_PATH", raising=False)
    for payload in ({}, {"content": 42}, None):
        r = client.put("/api/prompts/inbox", json=payload)
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert not (prompt_root / "prompts" / "email_inbox.md").exists()


def test_prompts_write_path_escape_rejected(
    client: TestClient, prompt_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LLM_*_PROMPT_PATH 逃逸 data root → E_PATH_ESCAPE（防写任意文件）。"""
    monkeypatch.setenv("LLM_INBOX_PROMPT_PATH", "../../../../tmp/evil.md")
    r = client.put("/api/prompts/inbox", json={"content": "x"})
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
            "/api/env",
            "/api/prompts/inbox",
        ):
            assert c.get(path).status_code == 401, path
        # 写端点同样鉴权（PUT /api/prompts/{slot}）。
        assert c.put("/api/prompts/inbox", json={"content": "x"}).status_code == 401
