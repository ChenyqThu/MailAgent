"""serve-api chat router 测试 — /api/chat/* 读端点（V2.1 阶段 2）。

镜像本地 IPC chat:listSessions/listAllSessions/listMessages/listToolCalls/kosAvailable 的
形状 + 鉴权 + graceful（库不存在 → []）。seed tmp ai_chat.db（前端 chat_db.ts v4 schema）+
tmp sync_store.db email_metadata（listAllSessions join）。store 经 monkeypatch 注入端点
（对齐 jobs/reports 直接调模式）。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb
from src.kos.client import KOSError  # kos-call 端点 KOSError→502 测试用

# ai_chat.db schema（端点 SELECT 字段，对齐 chat_db.ts v4）。
_AI_CHAT_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    backend_kind TEXT NOT NULL,
    backend_model TEXT,
    backend_agent_page_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
    status TEXT NOT NULL, error_message TEXT, metadata TEXT,
    thinking TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chat_tool_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
    user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
    duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
    content_offset INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
"""

EMAIL_ID = 1001
SESSION_ID = 1
MSG_USER_ID = 1
MSG_ASSISTANT_ID = 2


@pytest.fixture
def ai_chat_db(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(db))
    conn.executescript(_AI_CHAT_DDL)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, backend_kind, backend_model, "
        "backend_agent_page_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (SESSION_ID, EMAIL_ID, "custom-api", "claude-sonnet-4-6", None, now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?)",
        (MSG_USER_ID, SESSION_ID, "user", "这封邮件讲什么?", "complete", now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, model, "
        "tokens_input, tokens_output, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            MSG_ASSISTANT_ID, SESSION_ID, "assistant", "讲的是 redis timeout.", "complete",
            "claude-sonnet-4-6", 100, 50, now + 1, now + 1,
        ),
    )
    conn.execute(
        "INSERT INTO chat_tool_call (id, message_id, tool_use_id, tool_name, input_json, status, "
        "confirmation_tier, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (1, MSG_ASSISTANT_ID, "toolu_abc", "email_search", '{"query":"redis"}', "ok", "silent", now, now),
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def sync_store_db(tmp_path: Path) -> Path:
    db = tmp_path / "sync_store.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, subject TEXT, "
        "sender TEXT, sender_name TEXT)"
    )
    conn.execute(
        "INSERT INTO email_metadata (internal_id, subject, sender, sender_name) VALUES (?,?,?,?)",
        (EMAIL_ID, "Quarterly redis review", "alice@example.com", "Alice"),
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chat_client(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    chat_db = ChatDb(str(ai_chat_db))
    monkeypatch.setattr("src.api.routers.chat.get_chat_db", lambda: chat_db)

    class _StubConfig:
        sync_store_db_path = str(sync_store_db)

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _StubConfig())
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── sessions ──────────────────────────────────────────────────────────────


def test_list_sessions(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/sessions?emailId={EMAIL_ID}")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["id"] == SESSION_ID
    assert data[0]["backend_kind"] == "custom-api"
    assert data[0]["backend_model"] == "claude-sonnet-4-6"


def test_list_sessions_empty(chat_client: TestClient) -> None:
    assert chat_client.get("/api/chat/sessions?emailId=99999").json()["data"] == []


def test_list_sessions_missing_emailid_422(chat_client: TestClient) -> None:
    # 缺必填 emailId → RequestValidationError → E_INVALID_ARG envelope（阶段 1 全局 handler）。
    r = chat_client.get("/api/chat/sessions")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_all_sessions_with_email_join(chat_client: TestClient) -> None:
    """listAllSessions：预览 + message_count + join sync_store.db email subject/sender。"""
    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    s = data[0]
    assert s["first_user_message"] == "这封邮件讲什么?"
    assert s["message_count"] == 2
    assert s["email_subject"] == "Quarterly redis review"
    assert s["email_sender"] == "Alice"  # sender_name 优先于 sender


# ── messages ──────────────────────────────────────────────────────────────


def test_list_messages(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/sessions/{SESSION_ID}/messages")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 2
    assert data[0]["role"] == "user"
    assert data[0]["content"] == "这封邮件讲什么?"
    assert data[1]["role"] == "assistant"
    assert data[1]["tokens_input"] == 100
    assert data[1]["tokens_output"] == 50


def test_list_messages_empty(chat_client: TestClient) -> None:
    assert chat_client.get("/api/chat/sessions/99999/messages").json()["data"] == []


# ── tool calls ────────────────────────────────────────────────────────────


def test_list_tool_calls(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["tool_name"] == "email_search"
    assert data[0]["status"] == "ok"
    assert data[0]["confirmation_tier"] == "silent"


def test_list_tool_calls_empty(chat_client: TestClient) -> None:
    # user 消息无 tool_use → []
    assert chat_client.get(f"/api/chat/messages/{MSG_USER_ID}/tool-calls").json()["data"] == []


# ── kos-available ─────────────────────────────────────────────────────────


def test_kos_available_false(chat_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KOS_MCP_BASE", raising=False)
    monkeypatch.delenv("KOS_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("KOS_OAUTH_CLIENT_SECRET", raising=False)
    r = chat_client.get("/api/chat/kos-available")
    assert r.status_code == 200
    assert r.json()["data"] is False


def test_kos_available_true(chat_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KOS_MCP_BASE", "https://kos.example")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "secret")
    assert chat_client.get("/api/chat/kos-available").json()["data"] is True


# ── /config（V2.1 阶段 3c — chat 运行配置快照，renderer 预取覆盖 DEFAULT_HTTP_CONFIG）──


class _ChatConfigStub:
    """带全 chat 配置字段的 stub。chat_client fixture 的 _StubConfig 只有
    sync_store_db_path，config 端点读 agent_*/kos_*/llm_model 会 AttributeError，故自带。
    默认值对齐 electron chat/config.ts getter + DEFAULT_HTTP_CONFIG。"""

    agent_max_iter = 8
    agent_max_cost_usd = 0.5
    agent_harness_enabled = True
    kos_consumer_enabled = False
    kos_l1_hot_block_enabled = False
    kos_time_decay_enabled = True
    llm_model = "claude-sonnet-4-6"


def _config_client(
    monkeypatch: pytest.MonkeyPatch, cfg: object, user_context: str = ""
) -> TestClient:
    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: cfg)
    # task 06-08-chat 第二波 Bug B — stub the lazy ContextLoader so /config tests
    # don't hit Notion. Patch the _get_context_loader accessor (the singleton is
    # lazy / None until first use). Default "" (not configured); override per-test.
    async def _ctx() -> str:
        return user_context

    class _StubLoader:
        get_markdown = staticmethod(_ctx)

    monkeypatch.setattr("src.api.routers.chat._get_context_loader", lambda: _StubLoader())
    return TestClient(app, raise_server_exceptions=False)


def test_chat_config_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认快照：9 字段 camelCase 齐全 + 值对齐 electron 默认 + DEFAULT_HTTP_CONFIG。
    userContext 默认 ""（未配置 LLM_CONTEXT_PAGE_ID / ContextLoader 返回空）。"""
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    assert r.json()["data"] == {
        "maxIter": 8,
        "maxCostUsd": 0.5,
        "harnessEnabled": True,
        "kosL1HotBlockEnabled": False,
        "defaultModel": "claude-sonnet-4-6",
        "kosConsumerEnabled": False,
        "kosConfigured": False,
        "kosTimeDecayEnabled": True,
        "userContext": "",
        "enabledModels": [],
    }


def test_chat_config_user_context_injected(monkeypatch: pytest.MonkeyPatch) -> None:
    """task 06-08-chat 第二波 Bug B — ContextLoader 返回非空 markdown 时 userContext
    原样透传（custom-api system prompt 注入用户身份/Sender Priority）。"""
    ctx_md = "# Lucien\nRole: ENBU R&D\nSender Priority: boss@acme.com → Critical"
    with _config_client(monkeypatch, _ChatConfigStub(), user_context=ctx_md) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["userContext"] == ctx_md


def test_chat_config_user_context_graceful_on_loader_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ContextLoader 抛异常时 /config 不崩 —— userContext 降级 ""（best-effort，chat 仍可跑）。"""

    async def _boom() -> str:
        raise RuntimeError("notion down")

    class _BoomLoader:
        get_markdown = staticmethod(_boom)

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _ChatConfigStub())
    monkeypatch.setattr("src.api.routers.chat._get_context_loader", lambda: _BoomLoader())
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    assert r.json()["data"]["userContext"] == ""


def test_chat_config_kos_configured_mirrors_consumer(monkeypatch: pytest.MonkeyPatch) -> None:
    """kosConfigured == kosConsumerEnabled（同源 MAILAGENT_KOS_CONSUMER_ENABLED，对齐
    electron kosConfig().configured = isKosConsumerEnabled()，gate 9 KOS 工具注册；
    **非** OAuth 凭据齐的 _kos_available，那个 gate 的是 [✨ 保存到 KOS] 按钮）。"""

    class _Stub(_ChatConfigStub):
        kos_consumer_enabled = True

    with _config_client(monkeypatch, _Stub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["kosConsumerEnabled"] is True
    assert data["kosConfigured"] is True


def test_chat_config_non_default_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    """非默认 env（用户改 .env）原样透传 —— serve-api 是 chat 配置唯一真源（D-3c-3）。"""

    class _Stub(_ChatConfigStub):
        agent_max_iter = 12
        agent_max_cost_usd = 1.5
        agent_harness_enabled = False
        kos_l1_hot_block_enabled = True
        kos_time_decay_enabled = False
        llm_model = "claude-opus-4-8"

    with _config_client(monkeypatch, _Stub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["maxIter"] == 12
    assert data["maxCostUsd"] == 1.5
    assert data["harnessEnabled"] is False
    assert data["kosL1HotBlockEnabled"] is True
    assert data["kosTimeDecayEnabled"] is False
    assert data["defaultModel"] == "claude-opus-4-8"


def test_chat_config_normalizes_malformed_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """malformed/empty 值归一化对齐 electron getter（防过渡期 3c-2/3c-3 与 electron
    并存漂移；codex 3c-1 review MEDIUM）：maxIter<1→1、maxCostUsd≤0→0.5、llm_model ''→fallback。"""

    class _Stub(_ChatConfigStub):
        agent_max_iter = 0
        agent_max_cost_usd = -1.0
        llm_model = ""

    with _config_client(monkeypatch, _Stub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["maxIter"] == 1
    assert data["maxCostUsd"] == 0.5
    assert data["defaultModel"] == "claude-sonnet-4-6"


# ── graceful（库不存在）─────────────────────────────────────────────────────


def test_chat_db_graceful_missing() -> None:
    """ai_chat.db 不存在（全新用户无 chat 历史）→ 读函数返 []（不建空库，对齐前端 handler）。"""
    db = ChatDb("/nonexistent/path/to/ai_chat.db")
    assert db.list_sessions_for_email(1) == []
    assert db.list_all_sessions() == []
    assert db.list_messages(1) == []
    assert db.list_tool_calls_for_message(1) == []
    import os

    assert not os.path.exists("/nonexistent/path/to/ai_chat.db")  # 未被 connect 建空库


# ── codex review finding 1/2：_email_meta_for_sessions ─────────────────────


def test_email_meta_sender_name_empty_preserved(tmp_path: Path) -> None:
    """sender_name='' → 保留 ''（对齐 chat.ts sender_name ?? sender，仅 NULL 回退 sender）。"""
    from src.api.routers.chat import _email_meta_for_sessions

    sync = tmp_path / "sync.db"
    conn = sqlite3.connect(str(sync))
    conn.execute(
        "CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, subject TEXT, "
        "sender TEXT, sender_name TEXT)"
    )
    conn.execute("INSERT INTO email_metadata VALUES (1, 'S', 'bob@x.com', '')")  # 空字符串
    conn.execute("INSERT INTO email_metadata VALUES (2, 'S2', 'carol@x.com', NULL)")  # NULL
    conn.commit()
    conn.close()
    meta = _email_meta_for_sessions([1, 2], str(sync))
    assert meta[1]["sender"] == ""  # 空字符串保留（不回退 sender）
    assert meta[2]["sender"] == "carol@x.com"  # NULL 回退 sender


def test_email_meta_missing_sync_store_no_create(tmp_path: Path) -> None:
    """sync_store.db 不存在 → 返 {} 且不建空库（serve-api 只读，codex finding 1）。"""
    import os

    from src.api.routers.chat import _email_meta_for_sessions

    missing = str(tmp_path / "nonexistent_sync.db")
    assert _email_meta_for_sessions([1, 2], missing) == {}
    assert not os.path.exists(missing)  # 未被 connect 建空库


# ── llm-proxy（V2.1 阶段 3 3b-1：注入 key + 透传上游 SSE，非 envelope）────────


class _FakeUpstreamResp:
    """mock httpx streaming 上游响应（aiter_bytes 透传预设 SSE chunks）。"""

    def __init__(self, status_code: int, chunks: list) -> None:
        self.status_code = status_code
        self._chunks = chunks

    async def aiter_bytes(self):
        for c in self._chunks:
            yield c

    async def aclose(self) -> None:
        pass


def _patch_upstream(monkeypatch: pytest.MonkeyPatch, status_code: int, chunks: list) -> list:
    """monkeypatch src.api.routers.chat.httpx.AsyncClient → 返回预设上游响应。
    返回 captured 列表（build_request 的 url/json/headers）供断言注入正确 + key 不进 body。"""
    captured: list = []
    resp = _FakeUpstreamResp(status_code, chunks)

    class _Client:
        def __init__(self, *a, **k) -> None:
            pass

        def build_request(self, method, url, *, json=None, headers=None):
            captured.append({"method": method, "url": url, "json": json, "headers": headers})
            return {"url": url}

        async def send(self, req, stream=False):
            return resp

        async def aclose(self) -> None:
            pass

    monkeypatch.setattr("src.api.routers.chat.httpx.AsyncClient", _Client)
    return captured


@pytest.fixture
def llm_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    class _Cfg:
        llm_api_key = "cr_TEST_KEY"
        llm_api_base = "https://crs.example.com/api"
        sync_store_db_path = ":memory:"

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _Cfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_llm_proxy_invalid_body_missing_protocol(llm_client: TestClient) -> None:
    """缺 protocol → E_INVALID_ARG envelope（400），不打上游。"""
    r = llm_client.post("/api/chat/llm-proxy", json={"body": {"model": "x"}})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_llm_proxy_invalid_body_bad_protocol(llm_client: TestClient) -> None:
    r = llm_client.post(
        "/api/chat/llm-proxy", json={"protocol": "gemini", "body": {"model": "x"}}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_llm_proxy_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """serve-api host 无 LLM_API_KEY → E_NO_LLM_KEY envelope（不打上游）。"""

    class _Cfg:
        llm_api_key = ""
        llm_api_base = "https://crs.example.com/api"
        sync_store_db_path = ":memory:"

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _Cfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post(
            "/api/chat/llm-proxy",
            json={"protocol": "anthropic", "body": {"model": "claude-sonnet-4-6"}},
        )
    assert r.json()["error"]["code"] == "E_NO_LLM_KEY"


def test_llm_proxy_anthropic_passthrough_200(
    llm_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """上游 200 → StreamingResponse 透传原始 SSE + 注入 anthropic header（key 在 serve-api）。"""
    captured = _patch_upstream(monkeypatch, 200, [b'data: {"type":"message_stop"}\n\n'])
    r = llm_client.post(
        "/api/chat/llm-proxy",
        json={"protocol": "anthropic", "body": {"model": "claude-sonnet-4-6"}},
    )
    assert r.status_code == 200
    assert b"message_stop" in r.content
    # 注入：anthropic endpoint + x-api-key + UA（key 在 serve-api host，不进 shared req body）。
    assert captured[0]["url"].endswith("/v1/messages")
    assert captured[0]["headers"]["x-api-key"] == "cr_TEST_KEY"
    assert "anthropic-version" in captured[0]["headers"]
    assert "x-api-key" not in (captured[0]["json"] or {})  # key 不进 body


def test_llm_proxy_openai_passthrough_200(
    llm_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """openai protocol → /v1/chat/completions + Bearer。"""
    captured = _patch_upstream(monkeypatch, 200, [b"data: [DONE]\n\n"])
    r = llm_client.post(
        "/api/chat/llm-proxy",
        json={"protocol": "openai", "body": {"model": "gpt-5.4"}},
    )
    assert r.status_code == 200
    assert captured[0]["url"].endswith("/v1/chat/completions")
    assert captured[0]["headers"]["authorization"] == "Bearer cr_TEST_KEY"


def test_llm_proxy_upstream_429_status_passthrough(
    llm_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """上游 429 → 透传 status（空 body），shared 据 response.ok 归 E_QUOTA，不泄漏上游 body。"""
    _patch_upstream(monkeypatch, 429, [b"should-not-leak"])
    r = llm_client.post(
        "/api/chat/llm-proxy",
        json={"protocol": "anthropic", "body": {"model": "x"}},
    )
    assert r.status_code == 429
    assert b"should-not-leak" not in r.content


def test_llm_proxy_upstream_302_status_passthrough(
    llm_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """上游 3xx（重定向）→ 透传 status（不当 streaming success 转发 redirect body）。codex MEDIUM 回归。"""
    _patch_upstream(monkeypatch, 302, [b"<html>redirect</html>"])
    r = llm_client.post(
        "/api/chat/llm-proxy",
        json={"protocol": "anthropic", "body": {"model": "x"}},
    )
    assert r.status_code == 302
    assert b"redirect" not in r.content  # 仅 2xx passthrough，3xx body 不转发


def test_llm_proxy_build_request_invalid_url_cleanup_502(
    llm_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """build_request 抛 httpx.InvalidURL（非 HTTPError）→ broad except aclose + 502（不泄漏/不 500）。
    codex LOW 回归：旧 except httpx.HTTPError 漏 InvalidURL → 跳 aclose + generic 500。"""
    import httpx as _httpx

    closed = {"v": False}

    class _Client:
        def __init__(self, *a, **k) -> None:
            pass

        def build_request(self, *a, **k):
            raise _httpx.InvalidURL("malformed url")

        async def aclose(self) -> None:
            closed["v"] = True

    monkeypatch.setattr("src.api.routers.chat.httpx.AsyncClient", _Client)
    r = llm_client.post(
        "/api/chat/llm-proxy",
        json={"protocol": "anthropic", "body": {"model": "x"}},
    )
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "E_UPSTREAM"
    assert closed["v"] is True  # client.aclose() 被调，无连接泄漏


# ── chat 持久化写端点（V2.1 阶段 3 3b-3：镜像 chat_db.ts 写函数）──────────────
#
# 复用 chat_client fixture（writes 落同一 seeded tmp ai_chat.db，DDL = chat_db.ts v4 列）。
# 每端点写后读回验形状对齐 chat_db.ts + 边界（缺字段 / null vs 不存在 / key-presence patch）。


# ── sessions ────────────────────────────────────────────────────────────────


def test_open_session_reuse_existing(chat_client: TestClient) -> None:
    """getOrCreate：(emailId, custom-api, pageId=None) 命中 seed SESSION_ID=1（IS NULL 分支）。"""
    r = chat_client.post(
        "/api/chat/sessions", json={"emailId": EMAIL_ID, "backendKind": "custom-api"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["id"] == SESSION_ID  # 复用，不新建


def test_open_session_refreshes_model(chat_client: TestClient) -> None:
    """getOrCreate 命中 + backendModel 变了 → UPDATE model + updated_at（切 BackendSelector）。"""
    r = chat_client.post(
        "/api/chat/sessions",
        json={"emailId": EMAIL_ID, "backendKind": "custom-api", "backendModel": "claude-opus-4-8"},
    )
    data = r.json()["data"]
    assert data["id"] == SESSION_ID
    assert data["backend_model"] == "claude-opus-4-8"
    # 读回确认落库（非仅返回值）。
    got = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert got["backend_model"] == "claude-opus-4-8"


def test_open_session_new_email_inserts(chat_client: TestClient) -> None:
    r = chat_client.post(
        "/api/chat/sessions", json={"emailId": 2002, "backendKind": "custom-api"}
    )
    data = r.json()["data"]
    assert data["id"] != SESSION_ID
    assert data["email_id"] == 2002
    assert data["created_at"] == data["updated_at"]


def test_open_session_missing_fields_400(chat_client: TestClient) -> None:
    assert (
        chat_client.post("/api/chat/sessions", json={}).json()["error"]["code"]
        == "E_INVALID_ARG"
    )
    # emailId 非 int（bool 被排除）→ 400
    r = chat_client.post(
        "/api/chat/sessions", json={"emailId": True, "backendKind": "custom-api"}
    )
    assert r.status_code == 400


def test_create_new_session_always_inserts(chat_client: TestClient) -> None:
    """createNewSession：即使 (emailId, kind, pageId) 已存在也新建一行（绕过复用）。"""
    r = chat_client.post(
        "/api/chat/sessions/new", json={"emailId": EMAIL_ID, "backendKind": "custom-api"}
    )
    new_id = r.json()["data"]["id"]
    assert new_id != SESSION_ID
    # 该邮件现有 2 个 session（seed 的 + 新建的）。
    sessions = chat_client.get(f"/api/chat/sessions?emailId={EMAIL_ID}").json()["data"]
    assert len(sessions) == 2


def test_get_session_found_and_null(chat_client: TestClient) -> None:
    assert chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]["id"] == SESSION_ID
    r = chat_client.get("/api/chat/sessions/99999")
    assert r.status_code == 200  # 不 404
    assert r.json()["data"] is None  # ChatPersistPort 契约 = | null


# ── messages ──────────────────────────────────────────────────────────────


def test_append_message_and_readback(chat_client: TestClient) -> None:
    r = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "user", "content": "追加的一条", "status": "complete"},
    )
    assert r.status_code == 200
    msg = r.json()["data"]
    assert msg["role"] == "user"
    assert msg["content"] == "追加的一条"
    assert msg["status"] == "complete"
    # seed 有 2 条，现 3 条；新条在末尾（created_at 升序）。
    msgs = chat_client.get(f"/api/chat/sessions/{SESSION_ID}/messages").json()["data"]
    assert len(msgs) == 3
    assert msgs[-1]["id"] == msg["id"]
    # append bump session updated_at == 该消息 created_at（同一 now）。
    session = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert session["updated_at"] == msg["created_at"]


def test_append_message_missing_fields_400(chat_client: TestClient) -> None:
    # 缺 status
    r = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "user", "content": "x"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_append_message_empty_content_ok(chat_client: TestClient) -> None:
    """content='' 合法（NOT NULL 而非 non-empty；流式起始空气泡）。"""
    r = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "assistant", "content": "", "status": "streaming"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["content"] == ""


def test_stream_content_updates_content_only(chat_client: TestClient) -> None:
    """streamContent 仅更 content，status 不动（流式增量）。"""
    appended = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "assistant", "content": "", "status": "streaming"},
    ).json()["data"]
    mid = appended["id"]
    r = chat_client.patch(f"/api/chat/messages/{mid}/stream", json={"content": "增量片段"})
    assert r.status_code == 200
    got = chat_client.get(f"/api/chat/messages/{mid}").json()["data"]
    assert got["content"] == "增量片段"
    assert got["status"] == "streaming"  # 未被改


def test_stream_content_missing_content_400(chat_client: TestClient) -> None:
    r = chat_client.patch(f"/api/chat/messages/{MSG_ASSISTANT_ID}/stream", json={})
    assert r.status_code == 400


def test_finalize_message_full_patch(chat_client: TestClient) -> None:
    appended = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "assistant", "content": "draft", "status": "streaming"},
    ).json()["data"]
    mid = appended["id"]
    r = chat_client.patch(
        f"/api/chat/messages/{mid}",
        json={
            "status": "complete",
            "content": "终态正文",
            "tokensInput": 120,
            "tokensOutput": 80,
            "costUsd": 0.0123,
            "model": "claude-opus-4-8",
            "metadata": '{"thread_id":"t-9"}',
        },
    )
    assert r.status_code == 200
    got = chat_client.get(f"/api/chat/messages/{mid}").json()["data"]
    assert got["status"] == "complete"
    assert got["content"] == "终态正文"
    assert got["tokens_input"] == 120
    assert got["tokens_output"] == 80
    assert got["cost_usd"] == 0.0123
    assert got["model"] == "claude-opus-4-8"
    assert got["metadata"] == '{"thread_id":"t-9"}'


def test_finalize_message_persists_thinking(chat_client: TestClient) -> None:
    """task 06-08-chat 需求 5 — finalizeMessage 写 thinking 列（extended-thinking 摘要），
    readback 带出。append 不 seed thinking → 初始 null；patch thinking → 持久化 + 读回。"""
    appended = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "assistant", "content": "", "status": "streaming"},
    ).json()["data"]
    # append 不 seed thinking → 返回 + 行均 null（镜像 chat_db.ts appendMessage）。
    assert appended["thinking"] is None
    mid = appended["id"]
    r = chat_client.patch(
        f"/api/chat/messages/{mid}",
        json={"status": "complete", "content": "答案", "thinking": "Let me reason about it."},
    )
    assert r.status_code == 200
    got = chat_client.get(f"/api/chat/messages/{mid}").json()["data"]
    assert got["status"] == "complete"
    assert got["content"] == "答案"
    assert got["thinking"] == "Let me reason about it."


def test_finalize_message_partial_patch_preserves_unset(chat_client: TestClient) -> None:
    """省略的 key 不更新（TS undefined 语义）：只 patch status+error，content 原样保留。"""
    appended = chat_client.post(
        f"/api/chat/sessions/{SESSION_ID}/messages",
        json={"role": "assistant", "content": "原始正文", "status": "streaming"},
    ).json()["data"]
    mid = appended["id"]
    chat_client.patch(
        f"/api/chat/messages/{mid}", json={"status": "error", "errorMessage": "boom"}
    )
    got = chat_client.get(f"/api/chat/messages/{mid}").json()["data"]
    assert got["status"] == "error"
    assert got["error_message"] == "boom"
    assert got["content"] == "原始正文"  # 未传 content → 不动


def test_finalize_empty_patch_noop(chat_client: TestClient) -> None:
    """空 patch → no-op（不报错，对齐 chat_db.ts updateMessage 无字段早返）。"""
    r = chat_client.patch(f"/api/chat/messages/{MSG_ASSISTANT_ID}", json={})
    assert r.status_code == 200
    got = chat_client.get(f"/api/chat/messages/{MSG_ASSISTANT_ID}").json()["data"]
    assert got["content"] == "讲的是 redis timeout."  # seed 原值未变


def test_get_message_null(chat_client: TestClient) -> None:
    r = chat_client.get("/api/chat/messages/99999")
    assert r.status_code == 200
    assert r.json()["data"] is None


def test_delete_messages_from_id(chat_client: TestClient) -> None:
    """删 fromMessageId 及之后所有（含自身）。新建独立 session 隔离 seed 计数。"""
    sid = chat_client.post(
        "/api/chat/sessions/new", json={"emailId": 3003, "backendKind": "custom-api"}
    ).json()["data"]["id"]
    ids = []
    for i in range(3):
        m = chat_client.post(
            f"/api/chat/sessions/{sid}/messages",
            json={"role": "user", "content": f"m{i}", "status": "complete"},
        ).json()["data"]
        ids.append(m["id"])
    # 从第 2 条删起 → 删 2 条（含自身）。
    r = chat_client.delete(f"/api/chat/sessions/{sid}/messages/from/{ids[1]}")
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] == 2
    remaining = chat_client.get(f"/api/chat/sessions/{sid}/messages").json()["data"]
    assert [m["id"] for m in remaining] == [ids[0]]


def test_delete_session(chat_client: TestClient) -> None:
    """deleteSession：建独立 session + 消息 → DELETE → session 不可见 + 返 {deleted: True}。
    （CASCADE 删消息 + 工具调用是真实 schema FK 的职责，测试 DDL 无 FK 故不在此验，由前端
    chat_db deleteSession 测试钉；serve-api 端点职责 = 转发 DELETE + 正确 envelope。）"""
    sid = chat_client.post(
        "/api/chat/sessions/new", json={"emailId": 5005, "backendKind": "custom-api"}
    ).json()["data"]["id"]
    chat_client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"role": "user", "content": "hi", "status": "complete"},
    )
    # 删前可见。
    assert chat_client.get(f"/api/chat/sessions/{sid}").json()["data"]["id"] == sid
    r = chat_client.delete(f"/api/chat/sessions/{sid}")
    assert r.status_code == 200
    assert r.json()["data"] == {"deleted": True}
    # 删后 session 不可见（data=null，对齐 getSession row ?? null）。
    assert chat_client.get(f"/api/chat/sessions/{sid}").json()["data"] is None


def test_delete_session_nonexistent(chat_client: TestClient) -> None:
    """删不存在的 id 是 no-op（fire-and-forget 语义）→ 仍 200 {deleted: True}。"""
    r = chat_client.delete("/api/chat/sessions/99999")
    assert r.status_code == 200
    assert r.json()["data"] == {"deleted": True}


def test_open_session_invalid_backend_kind(chat_client: TestClient) -> None:
    """getOrCreateSession 非法 backendKind → E_INVALID_ARG（route 前置校验，不落 SQLite CHECK→500）。
    对齐 handlers/chat.ts validateStartOpts；cutover 后 runtime 经 HttpChatPlatform.persist 调此端点。"""
    r = chat_client.post("/api/chat/sessions", json={"emailId": 1, "backendKind": "bogus"})
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_new_session_invalid_backend_kind(chat_client: TestClient) -> None:
    """createNewSession 非法 backendKind → E_INVALID_ARG（同 open_session）。"""
    r = chat_client.post("/api/chat/sessions/new", json={"emailId": 1, "backendKind": "bogus"})
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_abort_streaming_messages(chat_client: TestClient) -> None:
    """pending/streaming → aborted；complete 不动。"""
    sid = chat_client.post(
        "/api/chat/sessions/new", json={"emailId": 4004, "backendKind": "custom-api"}
    ).json()["data"]["id"]
    for status in ("pending", "streaming", "complete"):
        chat_client.post(
            f"/api/chat/sessions/{sid}/messages",
            json={"role": "assistant", "content": status, "status": status},
        )
    r = chat_client.post(f"/api/chat/sessions/{sid}/abort")
    assert r.status_code == 200
    assert r.json()["data"]["aborted"] == 2  # pending + streaming
    msgs = chat_client.get(f"/api/chat/sessions/{sid}/messages").json()["data"]
    statuses = sorted(m["status"] for m in msgs)
    assert statuses == ["aborted", "aborted", "complete"]


# ── tool calls ──────────────────────────────────────────────────────────────


def test_append_tool_call_and_get_by_use_id(chat_client: TestClient) -> None:
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={
            "toolUseId": "toolu_new",
            "toolName": "email_get",
            "inputJson": '{"internal_id":42}',
            "confirmationTier": "silent",
            "status": "running",
        },
    )
    assert r.status_code == 200
    call = r.json()["data"]
    assert call["tool_name"] == "email_get"
    assert call["user_edited_input_json"] is None
    assert call["output_json"] is None
    # by-use-id 读回。
    got = chat_client.get(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls/toolu_new"
    ).json()["data"]
    assert got["id"] == call["id"]
    # 不存在 → data null（不 404）。
    miss = chat_client.get(f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls/toolu_nope")
    assert miss.status_code == 200
    assert miss.json()["data"] is None


def test_append_tool_call_missing_fields_400(chat_client: TestClient) -> None:
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={"toolUseId": "toolu_x"},  # 缺 toolName/inputJson/confirmationTier/status
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_append_tool_call_content_offset_round_trip(chat_client: TestClient) -> None:
    """task 06-08-chat Bug 2 — contentOffset 写入 + by-use-id 读回（前端据此交错渲染工具卡）。"""
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={
            "toolUseId": "toolu_off",
            "toolName": "email_search",
            "inputJson": "{}",
            "confirmationTier": "silent",
            "status": "running",
            "contentOffset": 23,
        },
    )
    assert r.status_code == 200
    assert r.json()["data"]["content_offset"] == 23
    got = chat_client.get(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls/toolu_off"
    ).json()["data"]
    assert got["content_offset"] == 23


def test_append_tool_call_content_offset_zero(chat_client: TestClient) -> None:
    """contentOffset=0（工具卡在任何文本之前）必须落 0、不被当成「缺省」置 NULL。"""
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={
            "toolUseId": "toolu_zero",
            "toolName": "email_get",
            "inputJson": "{}",
            "confirmationTier": "silent",
            "status": "running",
            "contentOffset": 0,
        },
    )
    assert r.status_code == 200
    assert r.json()["data"]["content_offset"] == 0


def test_append_tool_call_no_content_offset_is_null(chat_client: TestClient) -> None:
    """缺 contentOffset → NULL（旧前端 / degrade 路径，渲染回退到「工具卡在正文后」）。"""
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={
            "toolUseId": "toolu_noff",
            "toolName": "email_get",
            "inputJson": "{}",
            "confirmationTier": "silent",
            "status": "running",
        },
    )
    assert r.status_code == 200
    assert r.json()["data"]["content_offset"] is None


def test_append_tool_call_content_offset_non_int_400(chat_client: TestClient) -> None:
    """contentOffset 非 int（字符串）→ E_INVALID_ARG。"""
    r = chat_client.post(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls",
        json={
            "toolUseId": "toolu_bad",
            "toolName": "email_get",
            "inputJson": "{}",
            "confirmationTier": "silent",
            "status": "running",
            "contentOffset": "nope",
        },
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_update_tool_call(chat_client: TestClient) -> None:
    """seed tool_call id=1（toolu_abc，status='ok'）→ patch status/output/duration 读回。"""
    r = chat_client.patch(
        "/api/chat/tool-calls/1",
        json={"status": "error", "outputJson": '{"ok":false}', "durationMs": 42},
    )
    assert r.status_code == 200
    got = chat_client.get(
        f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls/toolu_abc"
    ).json()["data"]
    assert got["status"] == "error"
    assert got["output_json"] == '{"ok":false}'
    assert got["duration_ms"] == 42


# ── ChatDb 单元（update patch key-presence 语义，绕端点直测）─────────────────


def test_update_message_key_presence_semantics(ai_chat_db: Path) -> None:
    """``key in patch`` = TS ``!== undefined``：省略 key 不更；显式 None 更为 NULL；空 patch no-op。"""
    db = ChatDb(str(ai_chat_db))
    # 空 patch → no-op（content 保 seed 值）。
    db.update_message(MSG_ASSISTANT_ID, {})
    assert db.get_message(MSG_ASSISTANT_ID)["content"] == "讲的是 redis timeout."
    # 显式 None → 置 NULL（model seed 是 'claude-sonnet-4-6'）。
    db.update_message(MSG_ASSISTANT_ID, {"model": None})
    assert db.get_message(MSG_ASSISTANT_ID)["model"] is None
    # 省略 model、只更 content → model 不被重置回非 NULL。
    db.update_message(MSG_ASSISTANT_ID, {"content": "改了"})
    got = db.get_message(MSG_ASSISTANT_ID)
    assert got["content"] == "改了"
    assert got["model"] is None  # 仍 NULL（上一步置的，本步未传）


def test_update_tool_call_key_presence_semantics(ai_chat_db: Path) -> None:
    """update_tool_call 同 key-presence 语义（parity update_message）：空 patch no-op；
    显式 None 置 NULL；省略 key 不动。seed tool_call id=1（toolu_abc, status='ok'）。"""
    db = ChatDb(str(ai_chat_db))
    # 空 patch → no-op（status 保 seed 'ok'）。
    db.update_tool_call(1, {})
    assert db.get_tool_call_by_use_id(MSG_ASSISTANT_ID, "toolu_abc")["status"] == "ok"
    # 多字段更新落库。
    db.update_tool_call(1, {"status": "running", "confirmedAt": 12345})
    got = db.get_tool_call_by_use_id(MSG_ASSISTANT_ID, "toolu_abc")
    assert got["status"] == "running"
    assert got["confirmed_at"] == 12345
    # 省略 status、显式 confirmedAt=None → status 不动，confirmed_at 回 NULL（present key→更）。
    db.update_tool_call(1, {"confirmedAt": None})
    got = db.get_tool_call_by_use_id(MSG_ASSISTANT_ID, "toolu_abc")
    assert got["status"] == "running"  # 未传 → 不动
    assert got["confirmed_at"] is None  # 显式 None → NULL
    # userEditedInputJson explicit value 落库。
    db.update_tool_call(1, {"userEditedInputJson": '{"edited":true}'})
    assert (
        db.get_tool_call_by_use_id(MSG_ASSISTANT_ID, "toolu_abc")["user_edited_input_json"]
        == '{"edited":true}'
    )


def test_finalize_message_missing_body_400(chat_client: TestClient) -> None:
    """PATCH /messages/{id} 无 body（None / JSON null）→ E_INVALID_ARG（缺 patch 对象，codex LOW）。
    与 test_finalize_empty_patch_noop 互补：显式 {} 是合法 no-op，缺 body 才报错。"""
    r = chat_client.patch(f"/api/chat/messages/{MSG_ASSISTANT_ID}")
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_update_tool_call_missing_body_400(chat_client: TestClient) -> None:
    """PATCH /tool-calls/{id} 无 body → E_INVALID_ARG（同 finalize_message，codex LOW）。"""
    r = chat_client.patch("/api/chat/tool-calls/1")
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ── KOS 代理端点（3b-4：kos-call + save-to-kos）──────────────────────────────


def test_kos_call_proxies_name_args(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list = []

    class _MockKos:
        def call_tool(self, name, args):
            calls.append((name, args))
            return [{"slug": "people/bob"}]

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = chat_client.post(
        "/api/chat/kos-call", json={"name": "query", "args": {"query": "redis"}}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"] == [{"slug": "people/bob"}]
    assert calls == [("query", {"query": "redis"})]


def test_kos_call_missing_args_defaults_empty(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list = []

    class _MockKos:
        def call_tool(self, name, args):
            calls.append((name, args))
            return {"ok": 1}

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = chat_client.post("/api/chat/kos-call", json={"name": "list_skills"})
    assert r.status_code == 200
    assert calls == [("list_skills", {})]


def test_kos_call_kos_error_502(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _MockKos:
        def call_tool(self, name, args):
            raise KOSError("network down", "E_KOS_NETWORK")

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = chat_client.post("/api/chat/kos-call", json={"name": "query", "args": {}})
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "E_KOS_NETWORK"


def test_kos_call_missing_name_400(chat_client: TestClient) -> None:
    r = chat_client.post("/api/chat/kos-call", json={"args": {}})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


@pytest.fixture
def kos_save_client(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    """save-to-kos 端点 client：含 llm config stub（空 key → summarize fallback transcript，不打网）。"""
    chat_db = ChatDb(str(ai_chat_db))
    monkeypatch.setattr("src.api.routers.chat.get_chat_db", lambda: chat_db)

    class _Cfg:
        sync_store_db_path = str(sync_store_db)
        llm_api_key = ""  # 空 → summarize raise E_NO_LLM_KEY → fallback raw transcript
        llm_api_base = ""
        llm_model = ""

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _Cfg())
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_save_to_kos_fallback_transcript(
    kos_save_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict = {}

    class _MockKos:
        def put_page(self, slug, content):
            captured["slug"] = slug
            captured["content"] = content
            return {"slug": slug, "status": "created_or_updated"}

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = kos_save_client.post("/api/chat/save-to-kos", json={"messageId": MSG_ASSISTANT_ID})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["slug"] == f"chat-history/mailagent/{EMAIL_ID}/{SESSION_ID}/{MSG_ASSISTANT_ID}"
    assert data["status"] == "created_or_updated"
    assert data["contentBytes"] > 0
    # LLM 未配置 → fallback transcript（含 User/Assistant）+ frontmatter source_refs。
    assert "## User\n\n这封邮件讲什么?" in captured["content"]
    assert "## Assistant\n\n讲的是 redis timeout." in captured["content"]
    assert f"  - 'sources/email/{EMAIL_ID}'" in captured["content"]


def test_save_to_kos_message_not_found_404(
    kos_save_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: object())
    r = kos_save_client.post("/api/chat/save-to-kos", json={"messageId": 99999})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_save_to_kos_invalid_message_id_400(kos_save_client: TestClient) -> None:
    r = kos_save_client.post("/api/chat/save-to-kos", json={"messageId": -1})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_save_to_kos_role_not_assistant_400(
    kos_save_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # MSG_USER_ID 是 user role → E_INVALID_ARG（400）。
    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: object())
    r = kos_save_client.post("/api/chat/save-to-kos", json={"messageId": MSG_USER_ID})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
