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
# P2c — mirror chat_db.ts v7 (anchor): email_id nullable + anchor_type/anchor_id
# + coupling CHECK. The test fixture must track the real schema or db.py's anchor
# SELECT/INSERT (s.anchor_type / INSERT anchor columns) would fail against it.
# S6 W2 — mirror chat_db.ts v19: origin/agent_id/agent_job_id (list_all_sessions now
# SELECTs them so the record view can composer-lock agent sessions); without these the
# SELECT would OperationalError and _read_all would swallow it to [] (silent empty list).
_AI_CHAT_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email','general')),
    anchor_id INTEGER,
    backend_kind TEXT NOT NULL,
    backend_model TEXT,
    backend_agent_page_id TEXT,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    origin TEXT,
    agent_id TEXT,
    agent_job_id TEXT,
    last_read_at INTEGER,
    CHECK (
        (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
        OR
        (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
    )
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
    status TEXT NOT NULL, error_message TEXT, metadata TEXT,
    thinking TEXT,
    ui_message_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chat_tool_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
    user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
    duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
    content_offset INTEGER,
    approval_status TEXT, approval_hash TEXT,
    ui_payload_json TEXT,
    content_hash TEXT, idempotency_key TEXT,
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
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "backend_model, backend_agent_page_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (SESSION_ID, EMAIL_ID, "email", EMAIL_ID, "custom-api", "claude-sonnet-4-6", None, now, now),
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
    kos_consumer_enabled = False
    kos_l1_hot_block_enabled = False
    kos_time_decay_enabled = True
    llm_model = "claude-sonnet-4-6"
    user_md_compile_enabled = True
    standing_docs_editor_enabled = True
    memory_md_budget_chars = 5000
    custom_agents_enabled = True  # E3 cutover（2026-07-06）：pydantic 默认 True → /config.customAgentsEnabled 默认开


def _config_client(
    monkeypatch: pytest.MonkeyPatch, cfg: object,
    env_file: object = None,
) -> TestClient:
    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: cfg)
    # /config 热读 .env（kos 开关 + enabledModels，dotenv_values 绕 singleton）。测试默认
    # 隔离：env_file=None → get_env_file_path 返回 None → 热读 fallback 到 stub cfg，避免
    # 读开发机真实 .env（否则 MAILAGENT_KOS_* 等真实值会污染 stub）。需测热读时传临时 .env。
    monkeypatch.setattr("src.api.routers.chat.get_env_file_path", lambda: env_file)
    # task 07-21 —— Notion context page 不再注入 chat（Standing Context 单源），
    # /config 不再有 userContext 字段，也不再 lazy 拉 ContextLoader。
    return TestClient(app, raise_server_exceptions=False)


def test_chat_config_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认快照：字段 camelCase 齐全 + 值对齐 electron 默认 + DEFAULT_HTTP_CONFIG。
    task 07-21 起不再有 userContext（Notion context page 不注入 chat，Standing Context 单源）；
    memorySummary 默认 ""（MEM0_RETRIEVAL 默认开 —— 2026-07-02 cutover —— 但隔离
    agent_config.db 的 MEMORY doc 为空 → 不注入）。"""
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    data = r.json()["data"]
    # Phase -1 / 0A — config snapshot hashes (computed against the isolated temp
    # agent_config.db from conftest). Deterministic but not pinned to exact values
    # (would be brittle to template / builtin-skill changes) — assert sha256 hex shape.
    profile_hash = data.pop("agentProfileHash")
    installed_hash = data.pop("installedSkillsHash")
    assert isinstance(profile_hash, str) and len(profile_hash) == 64
    assert isinstance(installed_hash, str) and len(installed_hash) == 64
    # PR4 — Standing Context assembled (flag default ON; env_file=None → default True).
    # Seeded docs SOUL+AGENT+RULES+USER joined; assert structure, not exact bytes.
    standing = data.pop("standingContext")
    assert "# SOUL" in standing and "# AGENT" in standing
    assert "# RULES" in standing and "# USER" in standing
    # PR5 — per-skill enable overrides (empty store → no explicit overrides).
    assert data.pop("skillOverrides") == {}
    # P2a — memorySummaryMeta observability (no memory rows in the default stub →
    # None on a store hiccup, or an all-zero meta dict). Pop + assert shape, not pinned.
    mem_meta = data.pop("memorySummaryMeta")
    assert mem_meta is None or mem_meta["total"] == 0
    # M4a — advertisedSkills 是 skill-依赖列表（哪些 builtin skill default-on + available），
    # 同 hash/standingContext 不 pin、只 pop + 断言形状（None = store/manifest hiccup →
    # gateway fail-open 不门控；list[str] = 正常）。详见 advertised_skill_names。
    advertised = data.pop("advertisedSkills")
    assert advertised is None or all(isinstance(x, str) for x in advertised)
    assert data == {
        "maxIter": 8,
        "maxCostUsd": 0.5,
        "kosL1HotBlockEnabled": False,
        "defaultModel": "claude-sonnet-4-6",
        "kosConsumerEnabled": False,
        "kosConfigured": False,
        "kosTimeDecayEnabled": True,
        "memorySummary": "",
        "enabledModels": [],
        # R4 — flag default ON + seeded docs → layered prompt in effect.
        "standingContextActive": True,
        # R6 — override store healthy by default → available True.
        "skillOverridesAvailable": True,
        # M3c — user.md 偏好编译 flag（default True —— 2026-07-02 cutover；M3c 把它加进 /chat/config）。
        "userMdCompileEnabled": True,
        # standing-docs-editor flag（default True；4f4f71f2 加进 /chat/config）。
        "standingDocsEditorEnabled": True,
        # S2 W1 — exec 策略管理页显隐 flag（MAILAGENT_OPENNESS_EXEC_TOOLS，E3 cutover 默认 ON）。
        "execPolicyEnabled": True,
        # S2 W4b — Settings「Skill 安装」区显隐 flag（MAILAGENT_OPENNESS_SKILL_INSTALL，E3 cutover 默认 ON）。
        "skillInstallEnabled": True,
        # S5 — Custom AI Agents 入口显隐 flag（MAILAGENT_CUSTOM_AGENTS_ENABLED，E3 cutover 默认 ON；
        # 此处跟随 stub.custom_agents_enabled=True）。
        "customAgentsEnabled": True,
        # R3 (task 07-05) — S1 openness 三分面 flag 投影（E3 cutover 默认 ON，env_file=None → fallback True）。
        "sessionToolsEnabled": True,
        "configToolsEnabled": True,
        "webToolsEnabled": True,
        # task 07-12 P3/P5 — Settings「模型服务」区门控（MAILAGENT_LLM_PROVIDER_REGISTRY，
        # pydantic 默认已 cutover 翻 on 2026-07-13；此处 pin 的是 getattr 的 stub 兜底：
        # stub 无该字段 → False（fail-safe 走 legacy 投影，真实 config 恒有字段）。
        # pydantic 默认值本身由 test_provider_routing.test_flag_default_on_after_cutover pin。
        "providerRegistryEnabled": False,
    }


def test_chat_config_openness_flags_hot_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """R3 (task 07-05) — sessionTools/configTools/webTools 三字段热读 .env（镜像
    execPolicyEnabled 语义：main-env-only flag，改 .env 无需重启 serve-api 即生效）。"""
    env = tmp_path / ".env"
    env.write_text(
        "MAILAGENT_OPENNESS_SESSION_TOOLS=true\n"
        "MAILAGENT_OPENNESS_CONFIG_TOOLS=1\n"
        "MAILAGENT_OPENNESS_WEB_TOOLS=true\n"
        "MAILAGENT_OPENNESS_EXEC_TOOLS=true\n"
    )
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["sessionToolsEnabled"] is True
    assert data["configToolsEnabled"] is True
    assert data["webToolsEnabled"] is True
    # 既有字段回归：exec flag 同一热读通道
    assert data["execPolicyEnabled"] is True


def test_chat_config_memory_dump_retired(monkeypatch: pytest.MonkeyPatch) -> None:
    """M5b — agent_memory_kv dump 退役无条件 → memorySummary='' (前端
    `if (cfg.memorySummary && ...)` 真值门控不注入旧 `# Saved memory` 块，前端零改) +
    memorySummaryMeta 标 retired:True 供可观测。读侧改靠 mem0 召回（M2）+ user.md（M3）。
    退役无条件 → 不依赖 get_chat_db stub。"""
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["memorySummary"] == ""
    meta = data["memorySummaryMeta"]
    assert meta["retired"] is True
    assert meta["total"] == 0 and meta["injected"] == 0
    assert meta["chars"] == 0
    assert meta["truncated"] is False
    assert meta["max_entries"] == 20
    assert meta["max_chars"] == 2000


def test_chat_config_memory_md_injected_when_retrieval_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path, fresh_agent_cfg
) -> None:
    """task 07-01 — MAILAGENT_MEM0_RETRIEVAL 开 + memory.md 非空 → memorySummary = memory.md 内容
    （前端经 MEMORY fence untrusted 背景注入）+ meta retired False。"""
    from src.agent_config.store import MEMORY_DOC_NAME

    mem = "# MEMORY\n- prefers terse Chinese replies\n"
    fresh_agent_cfg.set_profile_doc(MEMORY_DOC_NAME, mem, updated_by="mem0")
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_MEM0_RETRIEVAL=true\n")
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    # 注入前 .content.strip()（尾部空白无意义）→ memorySummary = memory.md 去空白内容。
    assert data["memorySummary"] == mem.strip()
    meta = data["memorySummaryMeta"]
    assert meta["retired"] is False
    assert meta["injected"] == 1
    assert meta["chars"] == len(mem.strip())
    assert meta["source"] == "memory.md"


def test_chat_config_memory_md_empty_when_retrieval_on_but_no_memory(
    monkeypatch: pytest.MonkeyPatch, tmp_path, fresh_agent_cfg
) -> None:
    """task 07-01 — MEM0_RETRIEVAL 开但 memory.md 空 → memorySummary="" + retired meta
    （与 flag-off 字节级一致：前端真值门控不注入）。"""
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_MEM0_RETRIEVAL=true\n")
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["memorySummary"] == ""
    assert data["memorySummaryMeta"]["retired"] is True


def test_chat_config_memory_md_clamped_to_budget_on_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path, fresh_agent_cfg
) -> None:
    """task 07-01 步5（codex 步3 LOW）— 读侧 belt-and-suspenders：memory.md 超当前 budget
    （如用户调低 budget 后 rollback 到旧大版本）→ 注入前 clamp，memorySummary ≤ budget + truncated。"""
    from src.agent_config.store import MEMORY_DOC_NAME

    # 存进 store 的 memory.md 远超 budget（模拟 rollback 到旧大版本 / 调低 budget 前的内容）。
    mem = "# MEMORY\n" + "".join(f"- durable fact number {i}\n" for i in range(200))
    fresh_agent_cfg.set_profile_doc(MEMORY_DOC_NAME, mem, updated_by="mem0")
    stub = _ChatConfigStub()
    stub.memory_md_budget_chars = 120  # 远小于 mem 长度，强制读侧截断
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_MEM0_RETRIEVAL=true\n")
    with _config_client(monkeypatch, stub, env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert len(data["memorySummary"]) <= 120  # 恒注入 ≤ 当前预算
    assert len(data["memorySummary"]) < len(mem.strip())  # 确实截断了
    meta = data["memorySummaryMeta"]
    assert meta["truncated"] is True
    assert meta["chars"] == len(data["memorySummary"])
    assert meta["retired"] is False


def test_chat_config_advertised_skills_fail_soft(monkeypatch: pytest.MonkeyPatch) -> None:
    """M4a — advertised_skill_names 抛异常 → /chat/config 仍 200，advertisedSkills=None。
    None=未知 → AI SDK Gateway fail-OPEN（不门控）；区别于 []=全禁→门控删光 skill 工具。
    门控范围只读工具，fail-open 无害（write/send 另有 flag+审批）。镜像 fail_closed 测试姿态。"""
    import src.agent_config.projections as _proj

    def _boom(*a, **k):
        raise RuntimeError("manifest/store unavailable")

    monkeypatch.setattr(_proj, "advertised_skill_names", _boom)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    assert r.json()["data"]["advertisedSkills"] is None


def test_chat_config_skill_overrides_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """R6 — override store 读失败 → skillOverridesAvailable False + skillOverrides {} + 仍 200
    （不 500）。runtime 据该 flag 复用 last-known-good，不把禁用的 skill 静默复活。"""
    import src.agent_config.projections as _proj

    def _boom(*a, **k):
        raise RuntimeError("agent_config.db unavailable")

    monkeypatch.setattr(_proj, "skill_overrides_map", _boom)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        r = c.get("/api/chat/config")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["skillOverrides"] == {}
    assert data["skillOverridesAvailable"] is False


def test_chat_config_standing_context_flag_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """PR4 — MAILAGENT_STANDING_CONTEXT_ENABLED=false → standingContext ""（TS 回退
    SOUL_MARKDOWN，邮件态字节零回归）。flag 热读 .env，默认 ON。"""
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_STANDING_CONTEXT_ENABLED=false\n")
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["standingContext"] == ""
    # R4 — observability: flag off → layered prompt NOT in effect (legacy SOUL_MARKDOWN).
    assert data["standingContextActive"] is False


def _clear_kos_creds_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """隔离 os.environ 的真实 KOS 凭据（开发机 .env 已注入），让 kosConfigured 只由
    被测 .env 决定。chat_config 读凭据 = env_vals(.env) or os.environ。"""
    for k in ("KOS_MCP_BASE", "KOS_OAUTH_CLIENT_ID", "KOS_OAUTH_CLIENT_SECRET"):
        monkeypatch.delenv(k, raising=False)


def test_chat_config_kos_hot_read_overrides_stale_singleton(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """🔴 回归：serve-api 启动后才往 .env 加 MAILAGENT_KOS_CONSUMER_ENABLED=true + 凭据时，
    import-time config singleton 仍是 stale false。/config 改热读 .env 为准 → kosConfigured
    随 .env 即时翻 true（不必重启 serve-api），renderer createBuiltinTools 据此注册 9 个
    KOS 工具。kosConfigured = 启用 AND 凭据齐全（endpoint+client_id+secret）。"""
    _clear_kos_creds_env(monkeypatch)
    env = tmp_path / ".env"
    env.write_text(
        "MAILAGENT_KOS_CONSUMER_ENABLED=true\n"
        "MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true\n"
        "KOS_MCP_BASE=https://kos.example\n"
        "KOS_OAUTH_CLIENT_ID=gbrain_cl_test\n"
        "KOS_OAUTH_CLIENT_SECRET=gbrain_cs_test\n"
    )
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    # .env 为准：stub cfg 两个开关均 False，被 .env 的 true 覆盖；凭据齐 → configured
    assert data["kosConsumerEnabled"] is True
    assert data["kosConfigured"] is True
    assert data["kosL1HotBlockEnabled"] is True
    # 未在 .env → fallback 到 cfg（_ChatConfigStub.kos_time_decay_enabled = True）
    assert data["kosTimeDecayEnabled"] is True


def test_chat_config_kos_enabled_but_not_connected(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """🔴 用户需求：开了 consumer 开关但没配 KOS 凭据（未对接）→ kosConfigured=False，
    renderer 不注册 KOS 工具（避免注册了必然调用失败的工具）。kosConsumerEnabled 仍反映
    开关真值（True），UI 可据此显示「已启用但未对接」。"""
    _clear_kos_creds_env(monkeypatch)
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_KOS_CONSUMER_ENABLED=true\n")  # 开关开，无凭据
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["kosConsumerEnabled"] is True  # 开关真值
    assert data["kosConfigured"] is False  # 未对接 → 不注入


def test_chat_config_kos_cleared_via_env_overrides_stale_os_environ(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """修 review LOW：.env 显式清空某凭据 (KEY=) 即以 .env 为准 → kosConfigured 翻 False，
    不被 os.environ 启动注入的 stale 旧值覆盖 (clear-to-disable)。仅 key 完全不在 .env 时
    才回退 os.environ。"""
    # os.environ 模拟 serve-api 启动注入的旧凭据（齐全）
    monkeypatch.setenv("KOS_MCP_BASE", "https://old.kos")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "gbrain_cl_old")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "gbrain_cs_old")
    env = tmp_path / ".env"
    # 开关开 + .env 显式清空 endpoint（KEY=）；另两个不在 .env → 回退 os.environ 仍有值
    env.write_text("MAILAGENT_KOS_CONSUMER_ENABLED=true\nKOS_MCP_BASE=\n")
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["kosConsumerEnabled"] is True
    # endpoint 被 .env 显式清空 → 凭据不齐 → 未对接（不被 os.environ 旧值救回）
    assert data["kosConfigured"] is False


def test_chat_config_kos_configured_requires_consumer_and_creds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """kosConfigured = consumer 开关 AND OAuth 凭据齐全（注入 gate 从旧「纯镜像 consumer」
    收紧为「启用 AND 对接」）。凭据可来自 os.environ（启动注入）兜底 —— 此处 consumer=True
    + 三凭据置于 os.environ → configured True（覆盖 .env 之外的 os.environ 兜底路径）。"""

    class _Stub(_ChatConfigStub):
        kos_consumer_enabled = True

    monkeypatch.setenv("KOS_MCP_BASE", "https://kos.example")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "gbrain_cl_test")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "gbrain_cs_test")
    with _config_client(monkeypatch, _Stub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["kosConsumerEnabled"] is True
    assert data["kosConfigured"] is True


def test_chat_config_non_default_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    """非默认 env（用户改 .env）原样透传 —— serve-api 是 chat 配置唯一真源（D-3c-3）。"""

    class _Stub(_ChatConfigStub):
        agent_max_iter = 12
        agent_max_cost_usd = 1.5
        kos_l1_hot_block_enabled = True
        kos_time_decay_enabled = False
        llm_model = "claude-opus-4-8"

    with _config_client(monkeypatch, _Stub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["maxIter"] == 12
    assert data["maxCostUsd"] == 1.5
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


def test_create_new_session_accepts_ai_sdk_kind(chat_client: TestClient) -> None:
    """P4 Phase 06a — 'ai-sdk' 是合法 backendKind（chat_db v13 放宽 CHECK + 校验白名单同步放宽）。
    serve-api 只持久化该行（gateway 跑 turn），故必须接受、不报 E_INVALID_ARG。"""
    r = chat_client.post(
        "/api/chat/sessions/new", json={"emailId": EMAIL_ID, "backendKind": "ai-sdk"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["backend_kind"] == "ai-sdk"


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


def test_update_session_archived_hides_from_list_all(chat_client: TestClient) -> None:
    """PATCH /sessions/{id}/archived archived=true → 该 session 从 list_all_sessions 消失。
    镜像 test_delete_session 风格；验证 archived=false 可重新出现（软删可逆）。"""
    # seed SESSION_ID=1 有消息，list_all_sessions 应可见。
    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    ids_before = [s["id"] for s in r.json()["data"]]
    assert SESSION_ID in ids_before

    # 归档 → 应从列表消失。
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/archived", json={"archived": True})
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}

    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    assert SESSION_ID not in [s["id"] for s in r.json()["data"]]

    # 取消归档 → 重新可见（软删可逆）。
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/archived", json={"archived": False})
    assert r.status_code == 200
    r = chat_client.get("/api/chat/sessions/all")
    assert SESSION_ID in [s["id"] for s in r.json()["data"]]


def test_list_all_sessions_excludes_archived_by_default(chat_client: TestClient) -> None:
    """默认（无 include_archived）不返回 archived=1 的 session。"""
    import sqlite3 as _sqlite3
    import src.api.routers.chat as _chat_router
    now = int(time.time() * 1000)
    # 通过 monkeypatched get_chat_db 拿到 seeded ChatDb 实例，再直连写 archived=1 的 session。
    db = _chat_router.get_chat_db()
    archived_id = 999
    conn = _sqlite3.connect(db.db_path)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "backend_model, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (archived_id, None, "general", None, "custom-api", "claude-sonnet-4-6", 1, now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (9001, archived_id, "user", "archived session msg", "complete", now, now),
    )
    conn.commit()
    conn.close()

    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    ids = [s["id"] for s in r.json()["data"]]
    assert archived_id not in ids
    assert SESSION_ID in ids  # 活跃 session 仍可见


def test_list_all_sessions_include_archived_returns_archived(chat_client: TestClient) -> None:
    """include_archived=true 时归档 session 出现在结果中。"""
    import sqlite3 as _sqlite3
    import src.api.routers.chat as _chat_router
    now = int(time.time() * 1000)
    db = _chat_router.get_chat_db()
    archived_id = 998
    conn = _sqlite3.connect(db.db_path)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "backend_model, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (archived_id, None, "general", None, "custom-api", "claude-sonnet-4-6", 1, now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (9002, archived_id, "user", "another archived msg", "complete", now, now),
    )
    conn.commit()
    conn.close()

    r = chat_client.get("/api/chat/sessions/all?include_archived=true")
    assert r.status_code == 200
    ids = [s["id"] for s in r.json()["data"]]
    assert archived_id in ids
    assert SESSION_ID in ids  # 活跃 session 也在


def test_update_session_archived_invalid_body_400(chat_client: TestClient) -> None:
    """archived 不是 bool → E_INVALID_ARG（镜像 title 端点的类型校验）。"""
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/archived", json={"archived": "yes"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ── mark-read（harness-chat lane A B4，task 07-15，ai_chat.db v20）─────────────


def test_update_session_read_sets_watermark_without_reorder(chat_client: TestClient) -> None:
    """PATCH /sessions/{id}/read → last_read_at=now；刻意不 bump updated_at（已读不重排历史）。
    未读判定 = updated_at > last_read_at → 标读后应为「已读」。"""
    import sqlite3 as _sqlite3
    import src.api.routers.chat as _chat_router

    db = _chat_router.get_chat_db()
    conn = _sqlite3.connect(db.db_path)
    before = conn.execute(
        "SELECT updated_at, last_read_at FROM ai_chat_sessions WHERE id = ?", (SESSION_ID,)
    ).fetchone()
    conn.close()
    assert before[1] is None  # seed 行从未标读

    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/read")
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}

    conn = _sqlite3.connect(db.db_path)
    after = conn.execute(
        "SELECT updated_at, last_read_at FROM ai_chat_sessions WHERE id = ?", (SESSION_ID,)
    ).fetchone()
    conn.close()
    assert after[1] is not None and after[1] >= before[0]  # 水位落在（≥ 最后活动时间）
    assert after[0] == before[0]  # updated_at 未动 → 历史序不变


def test_update_session_read_nonexistent_id_is_noop(chat_client: TestClient) -> None:
    """改不存在的 id 是 no-op（UPDATE 匹配 0 行）→ 仍 200（best-effort UX 面）。"""
    r = chat_client.patch("/api/chat/sessions/424242/read")
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}


def test_list_all_sessions_carries_last_read_at(chat_client: TestClient) -> None:
    """list_all_sessions（s.*）带回 last_read_at → 前端未读徽标的数据面。"""
    chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/read")
    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    row = next(s for s in r.json()["data"] if s["id"] == SESSION_ID)
    assert row["last_read_at"] is not None


def test_update_session_read_pre_v20_db_is_graceful(tmp_path: Path) -> None:
    """pre-v20 库（缺 last_read_at 列，前端尚未迁移/启动竞态）→ 静默 no-op，不抛不 500。"""
    db_path = tmp_path / "old_ai_chat.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        "CREATE TABLE ai_chat_sessions (id INTEGER PRIMARY KEY, email_id INTEGER, "
        "backend_kind TEXT, created_at INTEGER, updated_at INTEGER);"
    )
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, backend_kind, created_at, updated_at) "
        "VALUES (1, 1001, 'ai-sdk', 0, 0)"
    )
    conn.commit()
    conn.close()
    old_db = ChatDb(str(db_path))
    old_db.update_session_last_read(1)  # 不得抛（OperationalError 被吞成 no-op）


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


# ── S1 R1 — search_sessions（ChatDb 直测 + /sessions/search 端点）────────────────
# FTS 表由前端 chat_db.ts v17 迁移建（schema 归前端 owns）；下方 _FTS_DDL 是测试 fixture
# 模拟「已迁移库」（db.py 本身 0 CREATE TABLE 不变式不破）。共用 seed（ai_chat_db fixture）
# **无** FTS 表 → 正好覆盖「旧库未迁移 → OperationalError → LIKE 降级」路径。

_FTS_DDL = """
CREATE VIRTUAL TABLE ai_chat_messages_fts USING fts5(
    content, content='ai_chat_messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER ai_chat_messages_fts_ai AFTER INSERT ON ai_chat_messages BEGIN
    INSERT INTO ai_chat_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER ai_chat_messages_fts_ad AFTER DELETE ON ai_chat_messages BEGIN
    INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER ai_chat_messages_fts_au AFTER UPDATE ON ai_chat_messages BEGIN
    INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO ai_chat_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts) VALUES ('rebuild');
"""


@pytest.fixture
def ai_chat_db_fts(ai_chat_db: Path) -> Path:
    """共用 seed 之上补 FTS 表 + 触发器 + rebuild backfill（= 前端 v17 迁移后的库形状），
    并加第二个 session（中文消息 ×2）供聚合/cap 断言。"""
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(ai_chat_db))
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (2, None, "general", None, "ai-sdk", "redis 复盘", now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?)",
        (10, 2, "user", "上季度 redis 超时复盘的结论是什么", "complete", now + 10, now + 10),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?)",
        (11, 2, "assistant", "redis 超时复盘结论：连接池上限调到 200", "complete", now + 11, now + 11),
    )
    conn.executescript(_FTS_DDL)
    conn.commit()
    conn.close()
    return ai_chat_db


def test_search_sessions_fts_cjk_substring(ai_chat_db_fts: Path) -> None:
    """FTS 路径：≥3 字符中文子串命中（trigram），按 session 聚合返回元数据 + snippet。"""
    db = ChatDb(str(ai_chat_db_fts))
    out = db.search_sessions("超时复盘")
    assert len(out) == 1
    hit = out[0]
    assert hit["session"]["id"] == 2
    assert hit["session"]["title"] == "redis 复盘"
    assert hit["session"]["anchor_type"] == "general"
    # 两条消息都含「超时复盘」→ 同 session 聚合成 2 条 snippet。
    assert len(hit["snippets"]) == 2
    for sn in hit["snippets"]:
        assert "超时复盘" in sn["snippet"]
        assert sn["role"] in ("user", "assistant")
        assert isinstance(sn["message_id"], int)


def test_search_sessions_short_query_like_fallback(ai_chat_db_fts: Path) -> None:
    """<3 字符 query：trigram 索引注定 0 命中 → LIKE 降级仍能搜到中文双字词。"""
    db = ChatDb(str(ai_chat_db_fts))
    out = db.search_sessions("复盘")
    assert len(out) == 1
    assert out[0]["session"]["id"] == 2
    assert any("复盘" in sn["snippet"] for sn in out[0]["snippets"])


def test_search_sessions_missing_fts_table_falls_back_to_like(ai_chat_db: Path) -> None:
    """旧库（未经前端 v17 迁移，无 FTS 表）：FTS 查询 OperationalError → LIKE 降级命中。"""
    db = ChatDb(str(ai_chat_db))
    out = db.search_sessions("redis timeout")
    assert len(out) == 1
    assert out[0]["session"]["id"] == SESSION_ID
    assert any("redis timeout" in sn["snippet"] for sn in out[0]["snippets"])


def test_search_sessions_fts_syntax_never_parsed(ai_chat_db_fts: Path) -> None:
    """query 恒转义为 FTS phrase：AND/OR/*/引号等 FTS 语法不被解析、不炸（返回 [] 或字面命中）。"""
    db = ChatDb(str(ai_chat_db_fts))
    for q in ('redis OR 超时', 'a" OR "b', "col:redis", "redis*", "NEAR(redis, 超时)"):
        out = db.search_sessions(q)
        assert isinstance(out, list)  # 绝不 OperationalError 泄漏
    # 字面 phrase 语义：库里没有字面 "redis OR 超时" 文本 → 0 命中（若 OR 被解析会命中）。
    assert db.search_sessions("redis OR 超时") == []


def test_search_sessions_caps(ai_chat_db_fts: Path) -> None:
    """session_limit / snippets_per_session / snippet_chars cap 全生效。"""
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(ai_chat_db_fts))
    # 5 个新 session、每个 4 条超长命中消息（触发器自动进 FTS）。
    long_body = "冗长前缀" * 120 + "唯一命中词组" + "冗长后缀" * 120
    mid = 100
    for sid in range(3, 8):
        conn.execute(
            "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (sid, None, "general", None, "ai-sdk", now + sid, now + sid),
        )
        for _ in range(4):
            mid += 1
            conn.execute(
                "INSERT INTO ai_chat_messages (id, session_id, role, content, status, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (mid, sid, "user", long_body, "complete", now + mid, now + mid),
            )
    conn.commit()
    conn.close()
    db = ChatDb(str(ai_chat_db_fts))
    out = db.search_sessions("唯一命中词组", session_limit=3, snippets_per_session=2, snippet_chars=80)
    assert len(out) == 3  # session cap
    for hit in out:
        assert len(hit["snippets"]) <= 2  # per-session snippet cap
        for sn in hit["snippets"]:
            # snippet_chars cap（含省略号 margin）+ 命中词居中切窗。
            assert len(sn["snippet"]) <= 80 + 2
            assert "唯一命中词组" in sn["snippet"]


def test_search_sessions_missing_db(tmp_path: Path) -> None:
    """库不存在 → []（graceful 读契约，不建空库）。"""
    db = ChatDb(str(tmp_path / "absent.db"))
    assert db.search_sessions("redis") == []
    assert not (tmp_path / "absent.db").exists()


def test_search_sessions_blank_query(ai_chat_db_fts: Path) -> None:
    db = ChatDb(str(ai_chat_db_fts))
    assert db.search_sessions("") == []
    assert db.search_sessions("   ") == []


def test_sessions_search_endpoint_shape(chat_client: TestClient) -> None:
    """GET /api/chat/sessions/search：envelope 形状 + 聚合 data（共用 seed 无 FTS 表 → LIKE
    降级路径，端点仍正常出结果）。"""
    r = chat_client.get("/api/chat/sessions/search", params={"q": "redis timeout"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["meta"]["count"] == 1
    hit = body["data"][0]
    assert hit["session"]["id"] == SESSION_ID
    assert hit["session"]["backend_kind"] == "custom-api"
    assert len(hit["snippets"]) >= 1
    assert "redis timeout" in hit["snippets"][0]["snippet"]


def test_sessions_search_endpoint_validation(chat_client: TestClient) -> None:
    """q 缺失/超长、limit 越界 → FastAPI 422（Query 校验挡在 ChatDb 之前）。"""
    assert chat_client.get("/api/chat/sessions/search").status_code == 422
    assert (
        chat_client.get("/api/chat/sessions/search", params={"q": "x" * 201}).status_code == 422
    )
    assert (
        chat_client.get(
            "/api/chat/sessions/search", params={"q": "redis", "limit": 21}
        ).status_code
        == 422
    )
