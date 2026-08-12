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
    anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email','general','matter')),
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
    trigger_id TEXT,
    trigger_kind TEXT,
    trigger_fired_at INTEGER,
    last_read_at INTEGER,
    pinned_at INTEGER,
    starred INTEGER NOT NULL DEFAULT 0,
    CHECK (
        (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
        OR
        (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
        OR
        (anchor_type = 'matter' AND email_id IS NULL AND anchor_id IS NOT NULL)
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
    # matter 投影对非 matter 行恒 None（下面那个用例证明它对 matter 行不 None）。
    assert s["matter_public_id"] is None
    assert s["matter_title"] is None


def test_list_all_sessions_projects_matter_identity(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """0812 —— 事项对话收口进主 chat 后，历史下拉里的 matter 会话必须自带 MAT-xxxx。

    anchor_id 是**内部** id，而事项的 REST 面（context-snapshot / chat-scope / undo）全按 public_id
    寻址：不投影这两列，从历史里选中一个事项会话就只剩一个数字，既拿不到上下文也标不出身份。

    🔴 同时钉住 anchor_type 判据：email 会话的 anchor_id 与 matter.id 是两个 id 空间，这里让它们
    **故意撞号**（都是 4242）——只按 anchor_id 查表会把邮件会话贴上别人的 MAT-xxxx。
    """
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(ai_chat_db))
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "backend_model, backend_agent_page_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (777, None, "matter", 4242, "ai-sdk", None, None, now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?)",
        (7771, 777, "user", "这件事到哪了?", "complete", now, now),
    )
    conn.commit()
    conn.close()

    conn = sqlite3.connect(str(sync_store_db))
    conn.execute("CREATE TABLE matter (id INTEGER PRIMARY KEY, public_id TEXT, title TEXT)")
    conn.execute(
        "INSERT INTO matter (id, public_id, title) VALUES (?,?,?)",
        (4242, "MAT-0042", "Vendor launch"),
    )
    # 与上面那封邮件的 internal_id 撞号 —— 只按 anchor_id 查表就会误贴。
    conn.execute(
        "INSERT INTO matter (id, public_id, title) VALUES (?,?,?)",
        (EMAIL_ID, "MAT-9999", "不该出现在邮件会话上"),
    )
    conn.commit()
    conn.close()

    chat_db = ChatDb(str(ai_chat_db))
    monkeypatch.setattr("src.api.routers.chat.get_chat_db", lambda: chat_db)

    class _StubConfig:
        sync_store_db_path = str(sync_store_db)

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _StubConfig())
    with TestClient(app, raise_server_exceptions=False) as c:
        data = c.get("/api/chat/sessions/all").json()["data"]
    by_id = {row["id"]: row for row in data}
    assert by_id[777]["matter_public_id"] == "MAT-0042"
    assert by_id[777]["matter_title"] == "Vendor launch"
    assert by_id[SESSION_ID]["matter_public_id"] is None


def _seed_matter_session(
    ai_chat_db: Path, sync_store_db: Path, *, with_matter_table: bool
) -> None:
    """777 = 一条 matter-anchored 会话（anchor_id=4242）。``with_matter_table=False`` 模拟
    join 读不到（库里根本没有 matter 表 / 锁 / 被删）—— 那时两键必须是 None 而不是消失。"""
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(ai_chat_db))
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "backend_model, backend_agent_page_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (777, None, "matter", 4242, "ai-sdk", None, None, now, now),
    )
    conn.commit()
    conn.close()
    if not with_matter_table:
        return
    conn = sqlite3.connect(str(sync_store_db))
    conn.execute("CREATE TABLE matter (id INTEGER PRIMARY KEY, public_id TEXT, title TEXT)")
    conn.execute(
        "INSERT INTO matter (id, public_id, title) VALUES (?,?,?)",
        (4242, "MAT-0042", "Vendor launch"),
    )
    # 与那封邮件的 internal_id 撞号 —— 只按 anchor_id 查表就会把邮件会话误贴成事项会话。
    conn.execute(
        "INSERT INTO matter (id, public_id, title) VALUES (?,?,?)",
        (EMAIL_ID, "MAT-9999", "不该出现在邮件会话上"),
    )
    conn.commit()
    conn.close()


def _matter_client(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    chat_db = ChatDb(str(ai_chat_db))
    monkeypatch.setattr("src.api.routers.chat.get_chat_db", lambda: chat_db)

    class _StubConfig:
        sync_store_db_path = str(sync_store_db)

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _StubConfig())
    return TestClient(app, raise_server_exceptions=False)


def test_get_session_projects_matter_identity(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 codex #2 —— **单条** session 读也必须带 matter 投影。

    ``/sessions/all`` 拿不到那行时（远程入口 / fullscreen 跳转 / 列表未含该行）前端会转而调
    ``GET /sessions/{id}``。此前这条路由只返回 ``anchor_type='matter'`` + 内部 ``anchor_id``，
    前端认不出 MAT- 编号 → 整场对话退化成"普通会话"：无事项 chip / 无检索范围 / 请求不带 matter
    快照 ⇒ gateway 的 matterScopeFilter 变 null，用户以为在这件事里说话、模型却在全局跑。
    """
    _seed_matter_session(ai_chat_db, sync_store_db, with_matter_table=True)
    with _matter_client(ai_chat_db, sync_store_db, monkeypatch) as c:
        data = c.get("/api/chat/sessions/777").json()["data"]
    assert data["anchor_type"] == "matter"
    assert data["matter_public_id"] == "MAT-0042"
    assert data["matter_title"] == "Vendor launch"


def test_get_session_matter_projection_is_null_when_join_unavailable(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """join 读不到时两键仍**在场**且为 None —— 读侧据此进入「上下文未就绪」而不是"普通会话"。"""
    _seed_matter_session(ai_chat_db, sync_store_db, with_matter_table=False)
    with _matter_client(ai_chat_db, sync_store_db, monkeypatch) as c:
        data = c.get("/api/chat/sessions/777").json()["data"]
    assert data["anchor_type"] == "matter"
    assert data["matter_public_id"] is None
    assert data["matter_title"] is None


def test_get_session_non_matter_row_unchanged(chat_client: TestClient) -> None:
    """非 matter 行不碰：email 会话的 anchor_id 与 matter.id 是两个 id 空间，投影不该介入。"""
    data = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert data["anchor_type"] == "email"
    assert "matter_public_id" not in data


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
    trusted_fragments = data.pop("trustedSkillFragments")
    assert trusted_fragments is None or "six capability tiers" in trusted_fragments
    # 阶段 0.5 — 技能名单（skill-依赖，同 advertisedSkills 不 pin 具体内容，只 pop + 断言形状）。
    catalog = data.pop("skillCatalog")
    assert catalog is None or all(isinstance(row["name"], str) for row in catalog)
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
            "skillCreatorEnabled": True,
            "agentPluginsEnabled": True,
        # S5 — Custom AI Agents 入口显隐 flag（MAILAGENT_CUSTOM_AGENTS_ENABLED，E3 cutover 默认 ON；
        # 此处跟随 stub.custom_agents_enabled=True）。
        "customAgentsEnabled": True,
        # @ custom-agent call 入口显隐（MAILAGENT_CUSTOM_AGENT_CALL，默认 ON）。
        "customAgentCallEnabled": True,
        # P3 — manual compact renderer projection, default ON.
        "chatCompactEnabled": True,
        # P4 — auto compact/overflow projection, default ON.
        "chatAutoCompactEnabled": True,
        # P5 — queued input renderer projection, default ON.
        "chatQueuedInputEnabled": True,
        # R3 (task 07-05) — S1 openness 三分面 flag 投影（E3 cutover 默认 ON，env_file=None → fallback True）。
        "sessionToolsEnabled": True,
        "configToolsEnabled": True,
        "webToolsEnabled": True,
        # P1 — main-env-only session provenance flag 的未读 UI 只读投影（默认 ON）。
        "sessionProvenanceEnabled": True,
        "triggerV2Enabled": True,
        "calendarTriggerEnabled": True,
        # task 07-12 P3/P5 — Settings「模型服务」区门控（MAILAGENT_LLM_PROVIDER_REGISTRY，
        # pydantic 默认已 cutover 翻 on 2026-07-13；此处 pin 的是 getattr 的 stub 兜底：
        # stub 无该字段 → False（fail-safe 走 legacy 投影，真实 config 恒有字段）。
        # pydantic 默认值本身由 test_provider_routing.test_flag_default_on_after_cutover pin。
        "providerRegistryEnabled": False,
        # Matters P1 — 事项工作台入口门控（MAILAGENT_MATTERS_ENABLED，默认 off 灰度中）；
        # 同 providerRegistryEnabled 走 getattr 兜底：stub 无该字段 → False。
        # （P1 commit a4c2ee1c 加进 /chat/config 时漏了本 pin，P2 session 补账。）
        "mattersEnabled": False,
        "matterAgentEnabled": False,
        # 08-01 PR4 — MCP 连接区门控（MAILAGENT_MCP_CONNECTORS，pydantic 默认 off 灰度中）；
        # 同 providerRegistryEnabled 走 getattr 兜底：stub 无该字段 → False。
        "connectorToolsEnabled": False,
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
        "MAILAGENT_SESSION_PROVENANCE=false\n"
        "MAILAGENT_CHAT_COMPACT=false\n"
        "MAILAGENT_CHAT_AUTO_COMPACT=false\n"
        "MAILAGENT_CHAT_QUEUED_INPUT=false\n"
        "MAILAGENT_TRIGGER_V2=false\n"
        "MAILAGENT_CUSTOM_AGENT_CALL=false\n"
    )
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert data["sessionToolsEnabled"] is True
    assert data["configToolsEnabled"] is True
    assert data["webToolsEnabled"] is True
    assert data["sessionProvenanceEnabled"] is False
    assert data["chatCompactEnabled"] is False
    assert data["chatAutoCompactEnabled"] is False
    assert data["chatQueuedInputEnabled"] is False
    assert data["triggerV2Enabled"] is False
    assert data["customAgentCallEnabled"] is False
    # 既有字段回归：exec flag 同一热读通道
    assert data["execPolicyEnabled"] is True


def test_chat_config_connector_flag_projection(monkeypatch: pytest.MonkeyPatch) -> None:
    """08-01 PR4 — connectorToolsEnabled 跟随 **pydantic** mcp_connectors_enabled。

    刻意不走 _hot_bool：/api/connector/* 的 _require_enabled 读的是冻结单例，热读 .env
    会让 UI 门与端点门劈叉（设置页渲染出连接区、点下去端点 409）。"""

    class _On(_ChatConfigStub):
        mcp_connectors_enabled = True

    class _Off(_ChatConfigStub):
        mcp_connectors_enabled = False

    with _config_client(monkeypatch, _On()) as c:
        assert c.get("/api/chat/config").json()["data"]["connectorToolsEnabled"] is True
    with _config_client(monkeypatch, _Off()) as c:
        assert c.get("/api/chat/config").json()["data"]["connectorToolsEnabled"] is False


def test_chat_config_skill_catalog_lists_every_builtin(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> None:
    """阶段 0.5 —— skillCatalog 列出全部 code-owned builtin，字段是 prompt 需要的六个。
    🔴 名单里也包含**关掉的** skill（matters 的 default_enabled 跟随 MAILAGENT_MATTERS_ENABLED，
    测试环境为 off）—— 「关掉 ≠ 从名单消失」正是渐进披露的前提。"""
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        catalog = c.get("/api/chat/config").json()["data"]["skillCatalog"]
    assert {row["name"] for row in catalog} == {
        "email",
        "search",
        "report",
        "calendar",
        "notion_agent",
        "custom_agent",
        "skill_creator",
        "matters",
    }
    assert set(catalog[0]) == {
        "name",
        "title",
        "description",
        "enabled",
        "available",
        "unavailableReason",
    }


def test_chat_config_skill_catalog_keeps_disabled_skills(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> None:
    """🔴 关掉一个 skill → 它 enabled=false 但**仍在名单里**（关掉 ≠ 消失）。

    名单是「有哪些能力存在」的事实；让被关掉的 skill 从名单蒸发，模型就既答不出「为什么做不了」
    也提不出 set_skill_enabled。对比 advertisedSkills（门控用）—— 那个才是「现在能用的」子集。
    """
    fresh_agent_cfg.set_enabled("report", False)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    row = next(r for r in data["skillCatalog"] if r["name"] == "report")
    assert row["enabled"] is False
    # 同一快照里 advertisedSkills（门控投影）确实把它去掉了 —— 两者语义不同，别混用。
    assert "report" not in (data["advertisedSkills"] or [])


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
    # 阶段 0.5-③（PR-2）：这份文档未分层 → per-layer 诊断**缺席**（不硬造一排 0）。
    assert "layers" not in meta


def test_chat_config_memory_md_layer_diagnostics(
    monkeypatch: pytest.MonkeyPatch, tmp_path, fresh_agent_cfg
) -> None:
    """阶段 0.5-③（PR-2）— 注入的 memory.md 已分层 → meta.layers = 每层 chars/budget，
    identity 前置（与落盘/注入序一致）。判据是**文档结构**，与 MAILAGENT_MEMORY_LAYERS 无关：
    本测试不碰那个 flag（flag 管的是 capture 写侧，读侧诊断照实描述文档现状）。"""
    from src.agent_config.store import MEMORY_DOC_NAME
    from src.memory.memory_md import assemble_memory_layers

    mem = assemble_memory_layers(
        {"identity": "- leads the Omada team", "preference": "- terse replies",
         "activity": "- reviewing the Q3 deck"}
    )
    fresh_agent_cfg.set_profile_doc(MEMORY_DOC_NAME, mem, updated_by="mem0")
    env = tmp_path / ".env"
    env.write_text("MAILAGENT_MEM0_RETRIEVAL=true\n")
    with _config_client(monkeypatch, _ChatConfigStub(), env_file=str(env)) as c:
        data = c.get("/api/chat/config").json()["data"]
    layers = data["memorySummaryMeta"]["layers"]
    assert [x["name"] for x in layers] == [
        "identity", "preference", "context", "activity", "experience",
    ]
    by_name = {x["name"]: x for x in layers}
    assert by_name["identity"]["chars"] == len("- leads the Omada team")
    assert by_name["identity"]["budget"] == 600
    assert by_name["activity"]["chars"] == len("- reviewing the Q3 deck")
    assert by_name["context"]["chars"] == 0


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
    data = r.json()["data"]
    assert data["advertisedSkills"] is None
    assert data["trustedSkillFragments"] is None


def test_chat_config_custom_agent_fragment_follows_skill_toggle(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> None:
    """W6 workflow guidance is code-owned and follows the advertised-skill enablement snapshot."""
    fresh_agent_cfg.set_enabled("custom_agent", False)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert "custom_agent" not in data["advertisedSkills"]
    assert data["trustedSkillFragments"] == ""


def test_chat_config_matters_skill_fragment_reaches_system_prompt(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> None:
    """0812 — 「挂一个事项跟进 skill」的真判据：它既要出现在 advertisedSkills，其 prompt_fragment
    还得进 trustedSkillFragments（后者是白名单，漏加 = skill 挂了但一句话也没进 system prompt）。

    显式 set_enabled 而不是靠 default —— default_enabled 跟随 MAILAGENT_MATTERS_ENABLED（测试环境
    默认 off），这里要钉的是「advertised 之后 fragment 到底进不进 prompt」。"""
    fresh_agent_cfg.set_enabled("matters", True)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert "matters" in data["advertisedSkills"]
    assert "matter_find" in data["trustedSkillFragments"]

    fresh_agent_cfg.set_enabled("matters", False)
    with _config_client(monkeypatch, _ChatConfigStub()) as c:
        data = c.get("/api/chat/config").json()["data"]
    assert "matters" not in data["advertisedSkills"]
    assert "matter_find" not in data["trustedSkillFragments"]


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


def test_open_matter_session_reuses_with_flag_off(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Matter anchor 是结构能力，不受 MAILAGENT_MATTERS_ENABLED 门控。"""
    monkeypatch.setenv("MAILAGENT_MATTERS_ENABLED", "false")
    payload = {"anchorType": "matter", "matterId": 501, "backendKind": "ai-sdk"}
    first = chat_client.post("/api/chat/sessions", json=payload)
    second = chat_client.post("/api/chat/sessions", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    assert first.json()["data"]["email_id"] is None
    assert first.json()["data"]["anchor_type"] == "matter"
    assert first.json()["data"]["anchor_id"] == 501


def test_create_new_matter_session_always_inserts(chat_client: TestClient) -> None:
    payload = {"anchorType": "matter", "matterId": 502, "backendKind": "ai-sdk"}
    first = chat_client.post("/api/chat/sessions/new", json=payload)
    second = chat_client.post("/api/chat/sessions/new", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"]["id"] != second.json()["data"]["id"]
    assert first.json()["data"]["anchor_type"] == "matter"
    assert first.json()["data"]["anchor_id"] == 502


@pytest.mark.parametrize("route", ["/api/chat/sessions", "/api/chat/sessions/new"])
@pytest.mark.parametrize("matter_id", [None, 0, -1, True, 1.5, "1"])
def test_matter_session_requires_positive_integer_id_422(
    chat_client: TestClient, route: str, matter_id: object
) -> None:
    r = chat_client.post(
        route,
        json={"anchorType": "matter", "matterId": matter_id, "backendKind": "ai-sdk"},
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


@pytest.mark.parametrize("route", ["/api/chat/sessions", "/api/chat/sessions/new"])
def test_matter_session_rejects_email_id_422(chat_client: TestClient, route: str) -> None:
    r = chat_client.post(
        route,
        json={
            "anchorType": "matter",
            "matterId": 503,
            "emailId": 503,
            "backendKind": "ai-sdk",
        },
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


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


def test_update_session_pinned_round_trip_without_reorder(chat_client: TestClient) -> None:
    """Pin/unpin persists pinned_at while leaving the activity timestamp unchanged."""
    before = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/pinned", json={"pinned": True})
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}
    pinned = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert isinstance(pinned["pinned_at"], int)
    assert pinned["updated_at"] == before["updated_at"]

    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/pinned", json={"pinned": False})
    assert r.status_code == 200
    unpinned = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert unpinned["pinned_at"] is None
    assert unpinned["updated_at"] == before["updated_at"]


def test_update_session_starred_round_trip_without_reorder(chat_client: TestClient) -> None:
    """Star is independent metadata: it persists but does not bump updated_at or pin the row."""
    before = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/starred", json={"starred": True})
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}
    starred = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert bool(starred["starred"]) is True
    assert starred["pinned_at"] is None
    assert starred["updated_at"] == before["updated_at"]

    chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/starred", json={"starred": False})
    unstarred = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert bool(unstarred["starred"]) is False
    assert unstarred["updated_at"] == before["updated_at"]


@pytest.mark.parametrize(
    ("suffix", "payload"),
    [("pinned", {"pinned": "yes"}), ("starred", {"starred": 1})],
)
def test_update_session_pin_star_invalid_body_400(
    chat_client: TestClient, suffix: str, payload: dict
) -> None:
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/{suffix}", json=payload)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ── W8 per-session 模型偏好（task 08-04 WP2）──────────────────────────────────────
# composer 换模型 → PATCH /sessions/{id}/model → 重开该会话时回填。这是「切会话各自记得
# 上次所选模型」的后端一半；前端一半在 frontend/tests/shared/useSessionModelPreference。


def test_update_session_model_round_trip_without_reorder(chat_client: TestClient) -> None:
    """写得进、读得出、**不 bump updated_at**（换模型不该把会话顶到历史最前）。"""
    before = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    r = chat_client.patch(
        f"/api/chat/sessions/{SESSION_ID}/model", json={"model": "openai:gpt-5.5"}
    )
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}
    after = chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]
    assert after["backend_model"] == "openai:gpt-5.5"
    assert after["updated_at"] == before["updated_at"]
    assert after["pinned_at"] == before["pinned_at"]


def test_update_session_model_null_clears(chat_client: TestClient) -> None:
    """model=null / '' → 清空该会话的偏好（回落全局默认），不是写字面 'null'。"""
    chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/model", json={"model": "openai:gpt-5.5"})
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/model", json={"model": None})
    assert r.status_code == 200
    assert chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]["backend_model"] is None

    chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/model", json={"model": "openai:gpt-5.5"})
    chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/model", json={"model": ""})
    assert chat_client.get(f"/api/chat/sessions/{SESSION_ID}").json()["data"]["backend_model"] is None


def test_update_session_model_nonexistent_id_is_noop(chat_client: TestClient) -> None:
    """改不存在的 id 是 no-op（对齐 title/archived 的 fire-and-forget 语义），仍 200。"""
    r = chat_client.patch("/api/chat/sessions/99999/model", json={"model": "openai:gpt-5.5"})
    assert r.status_code == 200
    assert r.json()["data"] == {"updated": True}


def test_update_session_model_invalid_body_400(chat_client: TestClient) -> None:
    """model 既不是 str 也不是 null → E_INVALID_ARG（对齐 title 端点的类型校验）。"""
    r = chat_client.patch(f"/api/chat/sessions/{SESSION_ID}/model", json={"model": 7})
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
    r = chat_client.post("/api/chat/kos-call", json={"name": "list_pages"})
    assert r.status_code == 200
    assert calls == [("list_pages", {})]


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


# ── kos-call 服务端只读边界（codex review HIGH，2026-07-24）───────────────────
#
# OAuth client 是 read+write scope，所以"只读"必须由端点 allowlist 结构性保证，
# 而不是靠 gateway 没注册写工具。


@pytest.mark.parametrize(
    "name", ["query", "search", "get_page", "find_experts", "list_pages", "get_backlinks"]
)
def test_kos_call_allows_the_six_read_tools(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """allowlist 内的 6 个只读 MCP 名放行，且原样透传给 call_tool。"""
    calls: list = []

    class _MockKos:
        def call_tool(self, name, args):
            calls.append((name, args))
            return []

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = chat_client.post("/api/chat/kos-call", json={"name": name, "args": {}})
    assert r.status_code == 200
    assert calls == [(name, {})]


@pytest.mark.parametrize(
    "name",
    [
        "put_page",
        "delete_page",
        "add_link",
        "add_tag",
        "extract_facts",
        "forget_fact",
        "list_skills",
        "get_skill",
        "recall",
        "run_doctor",
    ],
)
def test_kos_call_rejects_non_read_tools(
    chat_client: TestClient, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """写工具 / skill 发现 / admin 面一律 403，且**根本不触达 KOS**（call_tool 零调用）。"""
    calls: list = []

    class _MockKos:
        def call_tool(self, name, args):  # pragma: no cover — 断言它不被调到
            calls.append((name, args))
            return []

    monkeypatch.setattr("src.api.routers.chat._get_kos_client", lambda: _MockKos())
    r = chat_client.post("/api/chat/kos-call", json={"name": name, "args": {}})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_KOS_TOOL_NOT_ALLOWED"
    assert calls == []


def test_kos_call_allowlist_matches_gateway_read_tools() -> None:
    """allowlist 就是 gateway 6 个只读工具的 MCP 名 —— 多一个都是新开放面，必须显式改这里。"""
    from src.api.routers.chat import _KOS_READ_TOOL_ALLOWLIST

    assert _KOS_READ_TOOL_ALLOWLIST == frozenset(
        {"query", "search", "get_page", "find_experts", "list_pages", "get_backlinks"}
    )


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


def test_session_query_headless_scope_cannot_be_overridden(chat_client: TestClient, ai_chat_db: Path) -> None:
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(ai_chat_db))
    for sid, agent in ((20, "self-agent"), (21, "other-agent")):
        conn.execute(
            "INSERT INTO ai_chat_sessions (id,email_id,anchor_type,anchor_id,backend_kind,title,created_at,updated_at,origin,agent_id,agent_job_id,trigger_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, None, "general", None, "ai-sdk", agent, now, now, "agent", agent, str(sid), "cron"),
        )
        conn.execute(
            "INSERT INTO ai_chat_messages (session_id,role,content,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
            (sid, "user", f"history {agent}", "complete", now, now),
        )
    conn.commit()
    conn.close()

    response = chat_client.get(
        "/api/chat/sessions/all?origin=all&agentId=other-agent",
        headers={"X-MailAgent-Agent-Id": "self-agent", "X-MailAgent-Allow-All-History": "0"},
    )
    assert response.status_code == 200
    rows = response.json()["data"]
    assert [row["agent_id"] for row in rows] == ["self-agent"]
