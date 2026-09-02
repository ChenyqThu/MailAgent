"""群成本读面（g1，CHAT_DB v31）—— ``GET /api/chat/sessions/{id}/group-metrics``。

design §6 的两个指标口径，按台账行构造断言：

  * ``silentRunRate`` = COUNT(outcome ∈ silent|held_dup|skipped) / COUNT(*)
  * ``turnsPerHumanMessage`` = 「链根 trigger ∈ human|main_agent」的那些链上的全部 turn 数
    / 这样的链数。🔴 判据落在**链**上不是逐行：成员级联行的 trigger_kind 是 'agent'，逐行判
    会让分子只剩下每条链的第一行（指标恒 ≈1，正好把「一条人类消息引发多少次发言」这件要量的
    事量没了）。

红线 4：本读面**先于级联上线** —— 先量得出来，才让 agent 互相唤醒。
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER, anchor_type TEXT, anchor_id INTEGER,
    backend_kind TEXT NOT NULL, title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    origin TEXT, members_json TEXT, group_config_json TEXT
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
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, anchor_type, backend_kind, created_at, updated_at, "
        "origin, members_json) VALUES (1, 'general', 'ai-sdk', 1, 1, 'group', ?)",
        (json.dumps(["a1", "a2"]),),
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chatdb(chat_db_path: Path) -> ChatDb:
    return ChatDb(db_path=str(chat_db_path))


@pytest.fixture
def chat_client(monkeypatch: pytest.MonkeyPatch, chat_db_path: Path) -> Iterator[TestClient]:
    from src.api import deps as _deps
    import src.api.routers.chat as _chat_router

    monkeypatch.setattr(_deps, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    with TestClient(app) as client:
        yield client


def _turn(
    path: Path,
    *,
    chain_id: int,
    seq: int,
    outcome: str,
    trigger_kind: str = "agent",
    agent_id: str = "a1",
    tokens: tuple = (0, 0),
    cost=None,
    started_at=None,
    error=None,
) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute(
        "INSERT INTO ai_chat_group_turn (session_id, run_id, chain_id, seq, agent_id, "
        "trigger_kind, outcome, tokens_input, tokens_output, cost_usd, started_at, error) "
        "VALUES (1, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            chain_id,
            seq,
            agent_id,
            trigger_kind,
            outcome,
            tokens[0],
            tokens[1],
            cost,
            started_at if started_at is not None else int(time.time() * 1000),
            error,
        ),
    )
    conn.commit()
    conn.close()


def test_empty_ledger_returns_unknown_not_zero(chat_client: TestClient) -> None:
    """零 turn 行 → 两个指标都是 None（未知），**不是 0**。

    0% 沉默率与「还没跑过」在 UI 上是两件事：前者说「这群很省」，后者该显示「暂无数据」。
    """
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["silentRunRate"] is None
    assert data["turnsPerHumanMessage"] is None
    assert data["last1h"]["turns"] == 0
    assert data["last1h"]["costUsd"] is None
    assert data["lastStopReason"] is None


def test_silent_run_rate_counts_three_outcomes(chat_client: TestClient, chat_db_path: Path) -> None:
    _turn(chat_db_path, chain_id=1, seq=0, outcome="spoke", trigger_kind="human")
    _turn(chat_db_path, chain_id=1, seq=1, outcome="silent")
    _turn(chat_db_path, chain_id=1, seq=2, outcome="held_dup")
    _turn(chat_db_path, chain_id=1, seq=3, outcome="skipped")
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["silentRunRate"] == pytest.approx(3 / 4)


def test_turns_per_human_message_counts_whole_chains(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """两条人类链共 5 个 turn → 2.5；'agent' 触发的级联行照样计入分子。"""
    _turn(chat_db_path, chain_id=10, seq=0, outcome="spoke", trigger_kind="human")
    _turn(chat_db_path, chain_id=10, seq=1, outcome="spoke", trigger_kind="agent")
    _turn(chat_db_path, chain_id=10, seq=2, outcome="silent", trigger_kind="agent")
    _turn(chat_db_path, chain_id=11, seq=0, outcome="spoke", trigger_kind="main_agent")
    _turn(chat_db_path, chain_id=11, seq=1, outcome="spoke", trigger_kind="agent")
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["turnsPerHumanMessage"] == pytest.approx(5 / 2)


def test_judge_post_chain_is_not_a_human_chain(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """跨群投递（judge_post）开的链不进「每条人类消息引发几次发言」的口径。"""
    _turn(chat_db_path, chain_id=20, seq=0, outcome="spoke", trigger_kind="judge_post")
    _turn(chat_db_path, chain_id=20, seq=1, outcome="spoke", trigger_kind="agent")
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["turnsPerHumanMessage"] is None


def test_rolling_windows_and_cost(chat_client: TestClient, chat_db_path: Path) -> None:
    now = int(time.time() * 1000)
    _turn(
        chat_db_path, chain_id=1, seq=0, outcome="spoke", trigger_kind="human",
        tokens=(100, 20), cost=0.01, started_at=now - 60_000,
    )
    # 5 小时前 → 只进 24h 窗口。
    _turn(
        chat_db_path, chain_id=2, seq=0, outcome="spoke", trigger_kind="human",
        tokens=(200, 30), cost=0.02, started_at=now - 5 * 3_600_000,
    )
    # 2 天前 → 两个窗口都不进。
    _turn(
        chat_db_path, chain_id=3, seq=0, outcome="spoke", trigger_kind="human",
        tokens=(999, 999), cost=9.99, started_at=now - 2 * 86_400_000,
    )
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["last1h"] == {
        "turns": 1,
        "tokens": 120,
        "costUsd": pytest.approx(0.01),
        "caps": {"turns": None, "tokens": None, "costUsd": None},
    }
    assert data["last24h"]["turns"] == 2
    assert data["last24h"]["tokens"] == 350
    assert data["last24h"]["costUsd"] == pytest.approx(0.03)


def test_cost_all_null_stays_unknown(chat_client: TestClient, chat_db_path: Path) -> None:
    """整窗 cost 全 NULL → costUsd 为 None（未知 ≠ 0）。

    这条直接决定金额地板的行为：读成 0 会让「$1/小时」的地板永远命中不了却看起来在生效。
    """
    _turn(chat_db_path, chain_id=1, seq=0, outcome="spoke", trigger_kind="human", tokens=(10, 5))
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["last1h"]["costUsd"] is None
    assert data["last1h"]["tokens"] == 15


def test_caps_reflect_only_configured_values(chat_client: TestClient) -> None:
    """caps 只回 owner **配置过**的值；没配的回 None。

    🔴 出厂默认在 groupFloors.ts（单源），服务端刻意不抄一份数值 —— 抄了就是第五处手抄，且会
    在 owner 只改了其中一项时，把另外两项的「默认」冻结成写死的旧值。
    """
    chat_client.put("/api/chat/sessions/1/group-config", json={"hourlyTurns": 90})
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["last1h"]["caps"] == {"turns": 90, "tokens": None, "costUsd": None}


def test_last_stop_reason_is_the_newest_stopped_turn(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    now = int(time.time() * 1000)
    _turn(
        chat_db_path, chain_id=1, seq=0, outcome="stopped", trigger_kind="human",
        error="hourly_turns", started_at=now - 10_000,
    )
    _turn(
        chat_db_path, chain_id=2, seq=0, outcome="stopped", trigger_kind="human",
        error="chain_cap", started_at=now,
    )
    data = chat_client.get("/api/chat/sessions/1/group-metrics").json()["data"]
    assert data["lastStopReason"] == "chain_cap"
