"""ai translation-cache endpoints (src/api/routers/ai.py).

Phase B §2: getCached (read) + deleteCached (delete) against email_translation.
The wire shape is hand-written camelCase (TranslationCache:
{internalId,targetLang,segments:[{src,tgt}],source,model,fetchedAt}) — the
renderer reads it verbatim, so snake_case would break it. Miss → data:null
(getCached returns TranslationCache|null). delete → {deleted: bool}.

We seed email_translation on an ISOLATED DB (real column set) and override
get_repository so ai.py builds its TranslationRepository against it.
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
from src.api.deps import get_repository
from src.repository import AttachmentStore, EmailRepository

TRANS_ID = 555  # internal_id with a 'zh' cache row.
UNTRANSLATED_ID = 556  # internal_id present in email_metadata, no translation yet.


def _seed_translation_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            """CREATE TABLE email_metadata (
                   internal_id INTEGER PRIMARY KEY
               )"""
        )
        conn.execute("INSERT INTO email_metadata (internal_id) VALUES (?)", (TRANS_ID,))
        conn.execute(
            "INSERT INTO email_metadata (internal_id) VALUES (?)", (UNTRANSLATED_ID,)
        )
        conn.execute(
            """CREATE TABLE email_translation (
                   internal_id INTEGER PRIMARY KEY,
                   target_lang TEXT NOT NULL DEFAULT 'zh',
                   segments_json TEXT NOT NULL,
                   model TEXT,
                   source TEXT,
                   created_at REAL,
                   updated_at REAL,
                   FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
               )"""
        )
        now = time.time()
        segs = json.dumps([
            {"src": "Hello", "tgt": "你好"},
            {"src": "World", "tgt": "世界"},
            {"src": "  ", "tgt": "skip-empty"},   # cleaned out (blank src)
            {"src": "ok", "tgt": ""},               # cleaned out (blank tgt)
            "not-a-dict",                            # cleaned out (non-dict)
        ])
        conn.execute(
            "INSERT INTO email_translation "
            "(internal_id, target_lang, segments_json, model, source, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (TRANS_ID, "zh", segs, "gpt-x", "llm_gateway", now, now),
        )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture()
def trans_client(tmp_path: Path) -> Iterator[TestClient]:
    db = tmp_path / "trans.db"
    _seed_translation_db(db)
    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.pop(get_repository, None)


# ===========================================================================
# GET /api/ai/translation/{internal_id}
# ===========================================================================


def test_get_cached_hit_camelcase_and_cleaned_segments(trans_client):
    r = trans_client.get(f"/api/ai/translation/{TRANS_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["meta"]["source"] == "sqlite"
    data = body["data"]
    # camelCase wire keys (renderer reads verbatim — NOT snake_case).
    assert set(data) == {
        "internalId", "targetLang", "segments", "source", "model", "fetchedAt"
    }
    assert data["internalId"] == TRANS_ID
    assert data["targetLang"] == "zh"
    assert data["model"] == "gpt-x"
    assert data["source"] == "llm_gateway"
    # blank/non-dict segments dropped → only the 2 valid pairs survive.
    assert data["segments"] == [
        {"src": "Hello", "tgt": "你好"},
        {"src": "World", "tgt": "世界"},
    ]


def test_get_cached_miss_returns_null(trans_client):
    # No row for this id → data:null (valid state; 200).
    r = trans_client.get("/api/ai/translation/999000")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"] is None


def test_get_cached_wrong_lang_miss(trans_client):
    # Row exists for 'zh' only; asking 'en' → miss → null.
    r = trans_client.get(
        f"/api/ai/translation/{TRANS_ID}", params={"target_lang": "en"}
    )
    assert r.status_code == 200
    assert r.json()["data"] is None


# ===========================================================================
# DELETE /api/ai/translation/{internal_id}
# ===========================================================================


def test_delete_cached_hit_then_miss(trans_client):
    # First delete removes the row → deleted:true.
    r = trans_client.delete(f"/api/ai/translation/{TRANS_ID}")
    assert r.status_code == 200
    assert r.json()["data"] == {"deleted": True}
    assert r.json()["meta"]["source"] == "sqlite"

    # The cache is now gone → getCached returns null.
    r2 = trans_client.get(f"/api/ai/translation/{TRANS_ID}")
    assert r2.json()["data"] is None

    # Deleting again → deleted:false (idempotent, still 200).
    r3 = trans_client.delete(f"/api/ai/translation/{TRANS_ID}")
    assert r3.status_code == 200
    assert r3.json()["data"] == {"deleted": False}


def test_delete_cached_unknown_id_false(trans_client):
    r = trans_client.delete("/api/ai/translation/424242")
    assert r.status_code == 200
    assert r.json()["data"] == {"deleted": False}


# ===========================================================================
# PUT /api/ai/translation/{internal_id}
# ===========================================================================


def test_put_translation_fresh_insert_then_get(trans_client):
    payload = {
        "targetLang": "zh",
        "segments": [
            {"src": "Line one", "tgt": "第一行"},
            {"src": "Line two", "tgt": "第二行"},
        ],
        "model": "claude-sonnet-5",
        "source": "on_demand",
    }
    r = trans_client.put(f"/api/ai/translation/{UNTRANSLATED_ID}", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    data = body["data"]
    assert data["internalId"] == UNTRANSLATED_ID
    assert data["saved"] is True
    assert data["cacheKept"] is False
    assert data["segments"] == payload["segments"]
    assert data["model"] == "claude-sonnet-5"

    r_get = trans_client.get(f"/api/ai/translation/{UNTRANSLATED_ID}")
    assert r_get.status_code == 200
    assert r_get.json()["data"]["segments"] == payload["segments"]


def test_put_translation_anti_downgrade_keeps_richer_cache(trans_client):
    # TRANS_ID starts with 2 clean segments; saving only 1 must keep existing cache.
    r = trans_client.put(
        f"/api/ai/translation/{TRANS_ID}",
        json={
            "targetLang": "zh",
            "segments": [{"src": "Only one", "tgt": "只有一句"}],
            "model": "smaller-model",
            "source": "on_demand",
        },
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["saved"] is False
    assert data["cacheKept"] is True
    assert data["segments"] == [
        {"src": "Hello", "tgt": "你好"},
        {"src": "World", "tgt": "世界"},
    ]

    # Overwriting with >= 2 segments replaces the cache cleanly.
    richer = [
        {"src": "One", "tgt": "一"},
        {"src": "Two", "tgt": "二"},
        {"src": "Three", "tgt": "三"},
    ]
    r2 = trans_client.put(
        f"/api/ai/translation/{TRANS_ID}",
        json={
            "targetLang": "zh",
            "segments": richer,
            "model": "better-model",
            "source": "on_demand",
        },
    )
    assert r2.status_code == 200
    assert r2.json()["data"]["saved"] is True
    assert r2.json()["data"]["cacheKept"] is False
    assert trans_client.get(f"/api/ai/translation/{TRANS_ID}").json()["data"]["segments"] == richer


def test_put_translation_orphan_id_and_invalid_source(trans_client):
    r_orphan = trans_client.put(
        "/api/ai/translation/999999",
        json={
            "targetLang": "zh",
            "segments": [{"src": "Hi", "tgt": "嗨"}],
            "model": "m",
            "source": "on_demand",
        },
    )
    assert r_orphan.status_code == 200
    assert r_orphan.json()["data"]["saved"] is False
    assert r_orphan.json()["data"]["cacheKept"] is False

    r_bad = trans_client.put(
        f"/api/ai/translation/{UNTRANSLATED_ID}",
        json={
            "targetLang": "zh",
            "segments": [],
            "model": "m",
            "source": "bogus_source",
        },
    )
    assert r_bad.status_code == 422
