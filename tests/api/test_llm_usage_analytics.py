"""Phase 4 WP-4D — Cross-DB LLM Usage Analytics & Probe Log API tests."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

import src.agent_config.enabled_models as enabled_models_mod
import src.api.auth as auth_mod
from src.agent_config import secrets
from src.agent_config.llm_providers import (
    get_llm_provider_store,
    reset_llm_provider_store_cache,
)
from src.api.app import app
from src.config import config
from src.services.llm_usage_analytics import collect_llm_usage_analytics

LOCAL_TOK = "usage-test-local-token"
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


@pytest.fixture(autouse=True)
def _isolated_dbs(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setenv("MAILAGENT_AI_CHAT_DB_PATH", str(tmp_path / "ai_chat.db"))
    monkeypatch.setattr(config, "sync_store_db_path", str(tmp_path / "sync_store.db"))
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(secrets, "_run_security", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("no keychain")))
    monkeypatch.setattr(
        enabled_models_mod,
        "_resolve_seed_inputs",
        lambda: {
            "api_base": "https://crs.example.com/api",
            "api_key": "seed-key",
            "model": "claude-sonnet-4-6",
            "enabled_models": ["claude-sonnet-4-6"],
        },
    )
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()
    yield
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _seed_chat_db(path: str, now_ms: int) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE ai_chat_sessions (
            id INTEGER PRIMARY KEY,
            origin TEXT
        );
        CREATE TABLE ai_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            model TEXT,
            tokens_input INTEGER,
            tokens_output INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER,
            cost_usd REAL,
            speaker_agent_id TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE ai_chat_group_turn (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            model TEXT,
            tokens_input INTEGER,
            tokens_output INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER,
            cost_usd REAL,
            started_at INTEGER NOT NULL
        );
        CREATE TABLE ai_llm_usage_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            surface TEXT NOT NULL,
            provider_id TEXT,
            model TEXT NOT NULL,
            protocol TEXT,
            tokens_input INTEGER,
            tokens_output INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER,
            cost_usd REAL,
            latency_ms INTEGER,
            status TEXT NOT NULL,
            error_code TEXT,
            created_at INTEGER NOT NULL
        );
        """
    )
    conn.execute("INSERT INTO ai_chat_sessions (id, origin) VALUES (1, NULL), (2, 'agent'), (3, 'group')")
    # Manual chat turn (AI SDK total input=1000: 700 cacheRead, 100 cacheWrite, 200 uncached)
    conn.execute(
        """
        INSERT INTO ai_chat_messages
            (session_id, role, status, model, tokens_input, tokens_output,
             cache_read_tokens, cache_write_tokens, cost_usd, speaker_agent_id, created_at)
        VALUES
            (1, 'assistant', 'complete', 'claude-sonnet-4-6', 1000, 100, 700, 100, 0.01, NULL, ?),
            -- Group message MUST NOT be double-counted alongside ai_chat_group_turn
            (3, 'assistant', 'complete', 'claude-sonnet-4-6', 9999, 999, 0, 0, 9.99, 'agent-a', ?)
        """,
        (now_ms, now_ms),
    )
    # Canonical group turn
    conn.execute(
        """
        INSERT INTO ai_chat_group_turn
            (session_id, outcome, model, tokens_input, tokens_output,
             cache_read_tokens, cache_write_tokens, cost_usd, started_at)
        VALUES (3, 'spoke', 'claude-sonnet-4-6', 500, 50, 300, 0, 0.005, ?)
        """,
        (now_ms,),
    )
    # Auxiliary log entry (auto_title)
    conn.execute(
        """
        INSERT INTO ai_llm_usage_log
            (surface, provider_id, model, protocol, tokens_input, tokens_output,
             cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, status, created_at)
        VALUES ('auto_title', 'default', 'claude-haiku-4-5', 'anthropic', 200, 20, 0, 0, 0.001, 40, 'ok', ?)
        """,
        (now_ms,),
    )
    conn.commit()
    conn.close()


def _seed_sync_db(path: str, now_sec: float) -> None:
    now_ms = int(now_sec * 1000)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE llm_processing (
            internal_id INTEGER PRIMARY KEY,
            status TEXT,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_input_tokens INTEGER,
            cache_creation_input_tokens INTEGER,
            updated_at REAL
        );
        CREATE TABLE report (
            id TEXT PRIMARY KEY,
            status TEXT,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cost_usd REAL,
            generated_at REAL
        );
        CREATE TABLE matter_run (
            id INTEGER PRIMARY KEY,
            chat_session_id INTEGER NULL,
            status TEXT,
            model TEXT,
            usage_json TEXT,
            cost_usd REAL,
            completed_at INTEGER,
            created_at INTEGER NOT NULL
        );
        """
    )
    # Python uncached convention: input_tokens=100, cache_read=400 -> total input=500
    conn.execute(
        """
        INSERT INTO llm_processing VALUES
            (1, 'success', 'claude-sonnet-4-6', 100, 40, 400, 0, ?),
            (2, 'failed', 'claude-sonnet-4-6', 9999, 999, 0, 0, ?)
        """,
        (now_sec, now_sec),
    )
    conn.execute(
        "INSERT INTO report VALUES ('r1', 'ready', 'claude-sonnet-4-6', 300, 80, 0.004, ?)",
        (now_sec,),
    )
    # One headless matter_run (chat_session_id NULL -> counted), one chat-linked (MUST NOT double-count)
    conn.execute(
        "INSERT INTO matter_run VALUES (1, NULL, 'ok', 'claude-sonnet-4-6', ?, 0.002, ?, ?)",
        (
            json.dumps({"usage": {"inputTokens": 400, "outputTokens": 40, "cacheReadTokens": 200, "cacheWriteTokens": 0, "noCacheTokens": 200}}),
            now_ms,
            now_ms,
        ),
    )
    conn.execute(
        "INSERT INTO matter_run VALUES (2, 99, 'ok', 'claude-sonnet-4-6', ?, 8.88, ?, ?)",
        (json.dumps({"usage": {"inputTokens": 9999, "outputTokens": 999}}), now_ms, now_ms),
    )
    conn.commit()
    conn.close()


def test_cross_db_usage_analytics_no_double_count_and_token_cache_hit_rate(tmp_path) -> None:
    now_sec = time.time()
    now_ms = int(now_sec * 1000)
    chat_db = str(tmp_path / "ai_chat.db")
    sync_db = str(tmp_path / "sync_store.db")
    cfg_db = str(tmp_path / "agent_config.db")

    _seed_chat_db(chat_db, now_ms)
    _seed_sync_db(sync_db, now_sec)

    store = get_llm_provider_store()
    store.append_py_usage(
        surface="memory_capture",
        model="claude-haiku-4-5",
        protocol="anthropic",
        input_tokens=150,
        output_tokens=30,
        cache_read_tokens=150,
        cache_write_tokens=0,
        cost_usd=0.0005,
        latency_ms=25,
        created_at=now_ms,
    )
    store.append_probe_log(
        provider_id="default",
        protocol="anthropic",
        model="claude-sonnet-4-6",
        kind="test",
        ok=True,
        latency_ms=42,
        created_at=now_ms,
    )

    data = collect_llm_usage_analytics(
        range_key="7d",
        chat_db_path=chat_db,
        sync_db_path=sync_db,
        agent_config_db_path=cfg_db,
        now_sec=now_sec,
    )

    s = data["summary"]
    # 6 events total: chat(1), group(1), auto_title(1), email_classify(1), report(1), matter_run(1), memory_capture(1) -> 7!
    assert s["totalCalls"] == 7
    # Uncached input: 200 (chat) + 200 (group) + 200 (auto_title) + 100 (email) + 300 (report) + 200 (matter_run) + 150 (mem) = 1350
    assert s["uncachedInputTokens"] == 1350
    # Cache read: 700 + 300 + 0 + 400 + 0 + 200 + 150 = 1750
    assert s["cacheReadTokens"] == 1750
    # Cache write: 100
    assert s["cacheWriteTokens"] == 100
    # Total input = 1350 + 1750 + 100 = 3200
    assert s["totalInputTokens"] == 3200
    # Token-weighted hit rate = round(100 * 1750 / 3200, 1) = 54.7
    assert s["tokenCacheHitRatePct"] == pytest.approx(54.7, abs=0.1)
    assert s["estimatedCostUsd"] == pytest.approx(0.0225, abs=0.005)
    assert s["cacheSavedUsd"] > 0

    surfaces = {row["surface"]: row for row in data["bySurface"]}
    assert set(surfaces.keys()) == {
        "chat",
        "group",
        "auto_title",
        "email_classify",
        "report",
        "matter_run",
        "memory_capture",
    }
    assert len(data["probeLogs"]) == 1
    assert data["probeLogs"][0]["providerId"] == "default"


def test_probe_log_ring_prunes_at_200_and_usage_probelog_endpoints(client: TestClient) -> None:
    store = get_llm_provider_store()
    for i in range(210):
        store.append_probe_log(
            provider_id="default",
            protocol="anthropic",
            model="claude-sonnet-4-6",
            kind="probe",
            ok=(i % 2 == 0),
            message=f"entry-{i}",
        )

    logs = store.list_probe_logs(limit=200)
    assert len(logs) == 200
    assert logs[0]["message"] == "entry-209"

    r_bad = client.get("/api/llm/providers/usage?range=99d", headers=LOCAL_HEADERS)
    assert r_bad.status_code == 400

    r_usage = client.get("/api/llm/providers/usage?range=24h", headers=LOCAL_HEADERS)
    assert r_usage.status_code == 200
    payload = r_usage.json()["data"]
    assert payload["range"] == "24h"
    assert len(payload["series"]) == 24
    assert len(payload["probeLogs"]) == 50

    r_unauth_del = client.delete("/api/llm/providers/probelog")
    assert r_unauth_del.status_code == 403

    r_del = client.delete("/api/llm/providers/probelog", headers=LOCAL_HEADERS)
    assert r_del.status_code == 200
    assert r_del.json()["data"]["cleared"] == 200
    assert store.list_probe_logs(limit=50) == []
