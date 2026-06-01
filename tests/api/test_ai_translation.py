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


def _seed_translation_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            """CREATE TABLE email_translation (
                   internal_id INTEGER NOT NULL,
                   target_lang TEXT NOT NULL DEFAULT 'zh',
                   segments_json TEXT NOT NULL,
                   model TEXT,
                   source TEXT,
                   created_at REAL,
                   updated_at REAL,
                   PRIMARY KEY (internal_id, target_lang)
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
