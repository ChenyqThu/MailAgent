"""狼人杀一键建局（g3）—— ``POST /api/agent/labs/werewolf/new-game``。

一次调用要同时成立六件事：三道 404 门、七个 agent 行跨局复用、seed 可复现的角色分配、
三个群（W/S 的父是 M）、三份群设置（``preset`` / ``game`` / 法官位，**不含**五个地板数值）、
以及失败时不留半成品。

🔴 本文件的 DDL 必须带 ``group_config_json`` 列：``update_group_config`` 对缺列的库是
**静默 no-op**（测试全绿但一个字都没写进去）—— 所以建完 DDL 先断言列在。

🔴 建群的权威校验（成员上限 / 子群 ⊆ 父群 / chat-capable）在 ``chat.create_session_validated``，
本文件不重复钉那些判据（姊妹文件 test_chat_group_session / test_chat_group_subgroup 钉）。
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from loguru import logger

from src.agents import plugin_compat
from src.agents.agent_templates import WEREWOLF_JUDGE_TITLE, WEREWOLF_PLAYER_TITLES
from src.api.app import APIError, app
from src.chat.db import ChatDb
from src.chat.group_limits import RESPONSE_MODES

# v30 members_json + v31 三载体 + g2 父子两列的并集（建局写面需要的最小列集）。
_DDL = """
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
    members_json TEXT,
    parent_session_id INTEGER,
    invoked_by TEXT,
    group_config_json TEXT,
    CHECK (
        (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
        OR
        (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
    )
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL,
    tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
    status TEXT NOT NULL, error_message TEXT, metadata TEXT, thinking TEXT,
    speaker_agent_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE ai_chat_group_member (
    session_id INTEGER NOT NULL, agent_id TEXT NOT NULL,
    response_mode TEXT NOT NULL DEFAULT 'mention'
      CHECK (response_mode IN ('realtime','mention')),
    seen_through_id INTEGER NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE ai_chat_group_turn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL, run_id TEXT NOT NULL, chain_id INTEGER NOT NULL,
    seq INTEGER NOT NULL, agent_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('human','main_agent','agent','judge_post')),
    outcome TEXT NOT NULL
      CHECK (outcome IN ('spoke','silent','held_dup','skipped','failed','stopped')),
    message_id INTEGER NULL, model TEXT NULL,
    tokens_input INTEGER NULL, tokens_output INTEGER NULL, cost_usd REAL NULL,
    window_from_id INTEGER NULL, window_to_id INTEGER NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER NULL, error TEXT NULL
);
"""


@pytest.fixture
def chat_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_DDL)
    conn.commit()
    columns = {row[1] for row in conn.execute("PRAGMA table_info(ai_chat_sessions)")}
    conn.close()
    # 缺这一列 → update_group_config 静默 no-op → 「群设置写进去了」的断言全部假绿。
    assert "group_config_json" in columns
    return db


@pytest.fixture
def report_db_path(tmp_path: Path) -> Path:
    """真 SyncStore 建表（含 report_agent）—— agent 行由 import_custom_agent 真写真读。"""
    from src.mail.sync_store import SyncStore

    db = tmp_path / "store.db"
    SyncStore(str(db))
    return db


@pytest.fixture
def wolf_client(
    monkeypatch: pytest.MonkeyPatch,
    chat_db_path: Path,
    report_db_path: Path,
    fresh_agent_cfg,
) -> Iterator[TestClient]:
    from src.agent_config.llm_providers import reset_llm_provider_store_cache
    from src.api import deps as _deps
    from src.api.deps import get_report_store as _get_report_store_dep
    from src.api.routers import chat as _chat_router
    from src.reports.store import ReportStore

    chat_db = ChatDb(db_path=str(chat_db_path))
    store = ReportStore(db_path=str(report_db_path))
    monkeypatch.setattr(_deps, "get_chat_db", lambda: chat_db)
    monkeypatch.setattr(_deps, "get_report_store", lambda: store)
    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: chat_db)
    monkeypatch.setattr(_chat_router, "get_report_store", lambda: store)
    app.dependency_overrides[_get_report_store_dep] = lambda: store
    # 模板不带技能 / 连接器 / 模型，依赖体检对本批恒空；跑真 manifest 会把 skills 目录拖进来。
    monkeypatch.setattr(plugin_compat, "_unmet_dependencies", lambda agent: [])
    reset_llm_provider_store_cache()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
    app.dependency_overrides.pop(_get_report_store_dep, None)
    reset_llm_provider_store_cache()


def _enable_labs(client: TestClient) -> None:
    assert client.put("/api/agent/labs", json={"groupAgents": "on"}).status_code == 200


def _new_game(client: TestClient, **body) -> object:
    return client.post("/api/agent/labs/werewolf/new-game", json=body)


def _created(res) -> dict:
    assert res.status_code == 200, res.text
    return res.json()["data"]


def _sessions(chat_db_path: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(str(chat_db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM ai_chat_sessions ORDER BY id").fetchall()
    conn.close()
    return rows


def _agent_rows(report_db_path: Path) -> list[sqlite3.Row]:
    """建局写进去的 agent 行 —— 只看 ``type='custom'``：SyncStore 建库时就播了七个内建
    agent（日报 / 搜索 / 预处理 …），拿全表计数会把它们数进来。"""
    conn = sqlite3.connect(str(report_db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM report_agent WHERE type = 'custom' ORDER BY id").fetchall()
    conn.close()
    return rows


# ── 三道门 ──────────────────────────────────────────────────────────────────


def test_labs_off_404_not_found(
    wolf_client: TestClient, chat_db_path: Path, report_db_path: Path
) -> None:
    res = _new_game(wolf_client)
    assert res.status_code == 404
    error = res.json()["error"]
    assert error["code"] == "E_NOT_FOUND"
    assert "lab is disabled" in error["message"]
    # 门在最前面：一个 agent 行、一条会话都不该落地。
    assert _agent_rows(report_db_path) == []
    assert _sessions(chat_db_path) == []


def test_agent_plugins_off_404(monkeypatch: pytest.MonkeyPatch, wolf_client: TestClient) -> None:
    from src.skills import flags

    _enable_labs(wolf_client)
    monkeypatch.setattr(flags, "agent_plugins_enabled", lambda: False)
    res = _new_game(wolf_client)
    assert res.status_code == 404
    assert res.json()["error"]["message"] == "agent plugins feature is disabled"


def test_custom_agents_off_404(monkeypatch: pytest.MonkeyPatch, wolf_client: TestClient) -> None:
    from src.api import deps as _deps

    _enable_labs(wolf_client)

    class _Cfg:
        custom_agents_enabled = False

    monkeypatch.setattr(_deps, "get_settings", lambda: _Cfg())
    res = _new_game(wolf_client)
    assert res.status_code == 404
    assert res.json()["error"]["message"] == "custom agents feature is disabled"


def test_three_gate_messages_are_distinguishable(
    monkeypatch: pytest.MonkeyPatch, wolf_client: TestClient
) -> None:
    """三条 404 message 两两不等 —— 否则 owner 只知道「404」，不知道该去开哪个开关。"""
    from src.api import deps as _deps
    from src.skills import flags

    labs_off = _new_game(wolf_client).json()["error"]["message"]
    _enable_labs(wolf_client)
    monkeypatch.setattr(flags, "agent_plugins_enabled", lambda: False)
    plugins_off = _new_game(wolf_client).json()["error"]["message"]
    monkeypatch.setattr(flags, "agent_plugins_enabled", lambda: True)

    class _Cfg:
        custom_agents_enabled = False

    monkeypatch.setattr(_deps, "get_settings", lambda: _Cfg())
    custom_off = _new_game(wolf_client).json()["error"]["message"]
    assert len({labs_off, plugins_off, custom_off}) == 3


# ── 建局形状 ────────────────────────────────────────────────────────────────


def test_new_game_shapes(wolf_client: TestClient, chat_db_path: Path) -> None:
    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client, seed=7))

    rows = {row["id"]: row for row in _sessions(chat_db_path)}
    assert set(rows) == {data["mainSessionId"], data["wolfSessionId"], data["seerSessionId"]}
    main = rows[data["mainSessionId"]]
    wolf = rows[data["wolfSessionId"]]
    seer = rows[data["seerSessionId"]]

    main_members = json.loads(main["members_json"])
    assert main_members[0] == data["judgeAgentId"]
    assert len(main_members) == 7
    assert len(json.loads(wolf["members_json"])) == 3
    assert len(json.loads(seer["members_json"])) == 2
    assert json.loads(wolf["members_json"])[0] == data["judgeAgentId"]
    assert json.loads(seer["members_json"])[0] == data["judgeAgentId"]

    assert wolf["parent_session_id"] == main["id"]
    assert seer["parent_session_id"] == main["id"]
    assert main["parent_session_id"] is None
    assert [row["invoked_by"] for row in (main, wolf, seer)] == ["setup"] * 3

    assert data["title"] == "狼人杀 #1"
    assert main["title"] == "狼人杀 #1"
    assert wolf["title"] == "狼人杀 #1 · 狼群"
    assert seer["title"] == "狼人杀 #1 · 预言家"
    assert data["mainSession"]["id"] == main["id"]
    assert data["configApplied"] is True


def test_roles_counts_and_seed_reproducible(wolf_client: TestClient) -> None:
    _enable_labs(wolf_client)
    first = _created(_new_game(wolf_client, seed=1))

    counts = sorted(first["roles"].values())
    assert counts == ["seer", "villager", "villager", "villager", "wolf", "wolf"]
    assert set(first["roles"]) == {p["agentId"] for p in first["players"]}
    assert [p["title"] for p in first["players"]] == list(WEREWOLF_PLAYER_TITLES)
    for player in first["players"]:
        assert first["roles"][player["agentId"]] == player["role"]

    same_seed = _created(_new_game(wolf_client, seed=1))
    assert same_seed["roles"] == first["roles"]
    other_seed = _created(_new_game(wolf_client, seed=2))
    assert other_seed["roles"] != first["roles"]


def test_game_written_to_all_three_groups(wolf_client: TestClient, chat_db_path: Path) -> None:
    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client, seed=11))
    chat_db = ChatDb(db_path=str(chat_db_path))
    # 七个显示名（法官 + 六玩家）与应答 players[*].title 同源：子群名单只有本群成员，
    # 法官在子群的 <game_secret> 全表靠这份表取名。
    titles = {
        data["judgeAgentId"]: WEREWOLF_JUDGE_TITLE,
        **{p["agentId"]: p["title"] for p in data["players"]},
    }
    assert len(titles) == 7

    for key in ("mainSessionId", "wolfSessionId", "seerSessionId"):
        config = chat_db.get_group_config(data[key])["config"]
        assert config["preset"] == "werewolf"
        assert config["judgeAgentId"] == data["judgeAgentId"]
        assert config["game"] == {
            "kind": "werewolf",
            "seed": 11,
            "roles": data["roles"],
            "titles": titles,
        }
        # 🔴 地板数值不落库：默认值副本一旦落库就与 groupFloors.ts 单源脱钩。
        for numeric in ("chainCap", "hourlyTurns", "hourlyTokens", "hourlyUsd", "sessionTurnCap"):
            assert numeric not in config


def test_judge_scope_hash_matches_raw_members_json(
    wolf_client: TestClient, chat_db_path: Path
) -> None:
    """hash 钉的是 ``members_json`` **列原文**（重序列化的等价名单也算变，免卡判据同源）。"""
    import hashlib

    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client))
    chat_db = ChatDb(db_path=str(chat_db_path))
    conn = sqlite3.connect(str(chat_db_path))
    for key in ("mainSessionId", "wolfSessionId", "seerSessionId"):
        session_id = data[key]
        raw = conn.execute(
            "SELECT members_json FROM ai_chat_sessions WHERE id = ?", (session_id,)
        ).fetchone()[0]
        expected = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        read = chat_db.get_group_config(session_id)
        assert read["config"]["judgeScopeHash"] == expected
        assert read["judgeScopeStale"] is False
    conn.close()


def test_modes_written_column_level(wolf_client: TestClient, chat_db_path: Path) -> None:
    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client))
    chat_db = ChatDb(db_path=str(chat_db_path))
    judge = data["judgeAgentId"]

    for key in ("mainSessionId", "wolfSessionId", "seerSessionId"):
        read = chat_db.get_group_config(data[key])
        modes = read["modes"]
        assert set(modes) == set(read["members"])
        assert modes[judge] == "realtime"
        assert all(mode == "mention" for agent, mode in modes.items() if agent != judge)
        assert set(modes.values()) <= set(RESPONSE_MODES)

    conn = sqlite3.connect(str(chat_db_path))
    seen = [row[0] for row in conn.execute("SELECT seen_through_id FROM ai_chat_group_member")]
    conn.close()
    # 列级 UPSERT：gateway 的 seen 游标列不该被建局写面碰到。
    assert seen and all(value is None for value in seen)


# ── agent 行复用 ────────────────────────────────────────────────────────────


def test_templates_reused_across_games(wolf_client: TestClient, report_db_path: Path) -> None:
    _enable_labs(wolf_client)
    first = _created(_new_game(wolf_client))
    assert first["reusedAgents"] is False
    assert len(_agent_rows(report_db_path)) == 7

    second = _created(_new_game(wolf_client))
    assert second["reusedAgents"] is True
    assert second["judgeAgentId"] == first["judgeAgentId"]
    assert len(_agent_rows(report_db_path)) == 7
    # 局号只数顶级群：第一局留下的两个子群（`… · 狼群` / `… · 预言家`）也以同前缀开头，
    # 把它们算进去会让第二局叫「#4」。
    assert (first["title"], second["title"]) == ("狼人杀 #1", "狼人杀 #2")


def test_renamed_title_creates_new_row(wolf_client: TestClient, report_db_path: Path) -> None:
    """查重键只有标题（report_agent 没有 template_key 列）：owner 改名 → 下一局新建一份。

    这是显式登记的近似解 —— 有人「顺手修好」它时，本用例会红，提醒同批更新文档。
    """
    _enable_labs(wolf_client)
    _created(_new_game(wolf_client))
    conn = sqlite3.connect(str(report_db_path))
    conn.execute("UPDATE report_agent SET title = ? WHERE title = ?", ("丙玩家", "玩家丙"))
    conn.commit()
    conn.close()

    second = _created(_new_game(wolf_client))
    assert second["reusedAgents"] is False
    assert len(_agent_rows(report_db_path)) == 8


# ── 模型引用 ────────────────────────────────────────────────────────────────


def test_model_provider_missing_400(
    wolf_client: TestClient, chat_db_path: Path, report_db_path: Path
) -> None:
    _enable_labs(wolf_client)
    res = _new_game(wolf_client, judgeModel="nope:x")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
    # 校验在建任何东西之前 —— 未配 provider 的一局是「第三个 turn 整局死」，不能留半局。
    assert _agent_rows(report_db_path) == []
    assert _sessions(chat_db_path) == []


def test_model_applied_when_provider_exists(
    wolf_client: TestClient, report_db_path: Path
) -> None:
    from src.agent_config.llm_providers import get_llm_provider_store

    get_llm_provider_store().create_provider("anthropic", protocol="anthropic")
    _enable_labs(wolf_client)
    data = _created(
        _new_game(wolf_client, judgeModel="anthropic:opus", playerModel="anthropic:haiku")
    )

    models = {row["id"]: row["model"] for row in _agent_rows(report_db_path)}
    assert models[data["judgeAgentId"]] == "anthropic:opus"
    for player in data["players"]:
        assert models[player["agentId"]] == "anthropic:haiku"


# ── 参数校验 ────────────────────────────────────────────────────────────────


def test_seed_and_prefix_validation(wolf_client: TestClient) -> None:
    _enable_labs(wolf_client)
    for bad_seed in (True, -1, 2**31, "1", 1.5):
        res = _new_game(wolf_client, seed=bad_seed)
        assert res.status_code == 400, f"seed={bad_seed!r} should be rejected"
        assert res.json()["error"]["code"] == "E_INVALID_ARG"
    assert _new_game(wolf_client, titlePrefix="狼" * 41).status_code == 400
    assert _new_game(wolf_client, titlePrefix=5).status_code == 400
    assert _created(_new_game(wolf_client, titlePrefix=" "))["title"] == "狼人杀 #1"
    assert _created(_new_game(wolf_client, titlePrefix="测试局"))["title"] == "测试局 #1"


# ── 半成品与降级 ────────────────────────────────────────────────────────────


def test_compensation_on_subgroup_failure(
    monkeypatch: pytest.MonkeyPatch, wolf_client: TestClient, chat_db_path: Path
) -> None:
    """第三个群建失败 → 倒序删掉 M / W，一行不留（半成品比没有更难收拾）。"""
    from src.api.routers import chat as _chat_router

    real = _chat_router.create_session_validated
    calls = {"n": 0}

    async def flaky(opts):
        calls["n"] += 1
        if calls["n"] == 3:
            raise APIError("E_INVALID_ARG", "boom", source="sqlite")
        return await real(opts)

    monkeypatch.setattr(_chat_router, "create_session_validated", flaky)
    _enable_labs(wolf_client)
    res = _new_game(wolf_client)
    assert res.status_code == 400
    assert calls["n"] == 3
    assert _sessions(chat_db_path) == []


def test_config_apply_failure_reports_flag(
    monkeypatch: pytest.MonkeyPatch, wolf_client: TestClient, chat_db_path: Path
) -> None:
    """群设置写失败 → 200 + ``configApplied: False``，三个群仍在（owner 至少看得到、删得掉）。"""

    def boom(self, session_id, config):
        raise sqlite3.OperationalError("disk gone")

    monkeypatch.setattr(ChatDb, "update_group_config", boom)
    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client))
    assert data["configApplied"] is False
    assert len(_sessions(chat_db_path)) == 3


def test_response_never_logs_roles(wolf_client: TestClient) -> None:
    """日志只打三个 session id / seed / reusedAgents —— roles 是身份表，进日志就是一次泄漏。

    判据钉的是**谁是什么**，不是「日志里有没有 wolf 这四个字母」：那条 INFO 行本身写着
    ``main=… wolf=… seer=…``（三个群的 id 标签）。真正的泄漏形态是有人 log 了整个应答 dict ——
    那会同时带出 agent id、`villager` 和 roles/players 两个键，下面逐个拦。
    """
    _enable_labs(wolf_client)
    captured: list[str] = []
    sink_id = logger.add(lambda message: captured.append(str(message)), level="DEBUG")
    try:
        data = _created(_new_game(wolf_client))
    finally:
        logger.remove(sink_id)

    text = "".join(captured)
    assert "new-game" in text  # sink 确实抓到了那条日志（否则下面的断言恒真）
    assert re.search(r"\bvillager\b", text) is None
    for key in ("roles", "players", "judgeAgentId"):
        assert key not in text
    for agent_id in [data["judgeAgentId"], *(p["agentId"] for p in data["players"])]:
        assert agent_id not in text


# ── group_metrics 会话累计（§11.5）────────────────────────────────────────────


def _insert_turn(db_path: Path, session_id: int, seq: int, cost, tokens=(10, 20)) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO ai_chat_group_turn (session_id, run_id, chain_id, seq, agent_id, "
        "trigger_kind, outcome, tokens_input, tokens_output, cost_usd, started_at) "
        "VALUES (?, 'run', 1, ?, 'a1', 'human', 'spoke', ?, ?, ?, ?)",
        (session_id, seq, tokens[0], tokens[1], cost, 1000 + seq),
    )
    conn.commit()
    conn.close()


@pytest.fixture
def metrics_session(chat_db_path: Path) -> int:
    conn = sqlite3.connect(str(chat_db_path))
    cur = conn.execute(
        "INSERT INTO ai_chat_sessions (anchor_type, backend_kind, created_at, updated_at, "
        "origin, members_json) VALUES ('general', 'ai-sdk', 1, 1, 'group', ?)",
        (json.dumps(["a1", "a2"]),),
    )
    conn.commit()
    session_id = int(cur.lastrowid)
    conn.close()
    return session_id


def test_group_metrics_session_totals(chat_db_path: Path, metrics_session: int) -> None:
    chat_db = ChatDb(db_path=str(chat_db_path))
    empty = chat_db.group_metrics(metrics_session)
    assert (empty["sessionTurns"], empty["sessionTokens"], empty["sessionCostUsd"]) == (0, 0, None)

    _insert_turn(chat_db_path, metrics_session, 1, 0.5)
    _insert_turn(chat_db_path, metrics_session, 2, 0.25)
    _insert_turn(chat_db_path, metrics_session, 3, None)
    metrics = chat_db.group_metrics(metrics_session)
    assert metrics["sessionTurns"] == 3
    assert metrics["sessionTokens"] == 90
    # 一条 NULL 不该把总额清成未知，也不该被当成 0.0 —— 求和只跨非 NULL 行。
    assert metrics["sessionCostUsd"] == pytest.approx(0.75)


def test_group_metrics_session_cost_all_null_is_unknown(
    chat_db_path: Path, metrics_session: int
) -> None:
    _insert_turn(chat_db_path, metrics_session, 1, None)
    _insert_turn(chat_db_path, metrics_session, 2, None)
    metrics = ChatDb(db_path=str(chat_db_path)).group_metrics(metrics_session)
    assert metrics["sessionTurns"] == 2
    assert metrics["sessionCostUsd"] is None  # 未知 ≠ 0


def test_agent_titles_match_constants(wolf_client: TestClient, report_db_path: Path) -> None:
    """七行的标题逐字是两个常量：@ 解析按**显示名**匹配，改一个字法官就唤不醒玩家。"""
    _enable_labs(wolf_client)
    data = _created(_new_game(wolf_client))
    titles = {row["id"]: row["title"] for row in _agent_rows(report_db_path)}
    assert titles[data["judgeAgentId"]] == WEREWOLF_JUDGE_TITLE
    assert [titles[p["agentId"]] for p in data["players"]] == list(WEREWOLF_PLAYER_TITLES)
