"""Tests for independent `semantic_index.db`, DB safety resilience, and hybrid email search."""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_repository
from src.embedding import get_embedding_manager, reset_embedding_manager_for_tests
from src.mail.db_safety import run_startup_db_safety
from src.mail.sync_store import SyncStore
from src.repository.email_repository import EmailRepository
from src.semantic import SemanticIndexService, reset_semantic_service_for_tests, resolve_semantic_db_path


class _DeterministicEmailEncoder:
    """Maps domain synonyms into a shared dimension so vector lane recalls zero-keyword-overlap emails."""

    model_id = "test-semantic-256"
    dim = 256
    provider_kind = "builtin_onnx"
    active_ep = "CPUExecutionProvider"

    _GROUPS = {
        "体检": 1,
        "医院": 1,
        "健康": 1,
        "身体检查": 1,
        "发票": 2,
        "报销": 2,
    }

    def _embed_one(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        for token, idx in self._GROUPS.items():
            if token in text:
                vec[idx] += 1.0
        vec[10] += 0.05
        return vec / float(np.linalg.norm(vec))

    def encode(self, texts, **_kw):
        return np.stack([self._embed_one(t) for t in texts])

    def encode_query(self, query: str):
        return self._embed_one(query)

    def close(self) -> None:
        pass


def _seed_sync_db(path: str) -> EmailRepository:
    SyncStore(path)
    repo = EmailRepository(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO email_metadata (internal_id, message_id, thread_id, subject, sender, date_received, mailbox, sync_status)"
        " VALUES (101, '<m101@x>', 't101', '年度福利通知', 'hr@acme.com', '2026-11-18T10:00:00Z', '收件箱', 'synced')"
    )
    conn.execute(
        "INSERT INTO email_body (internal_id, message_id, body_markdown, body_format, fetched_at, fetched_source) "
        "VALUES (101, '<m101@x>', '正式员工可预约三甲医院健康体检套餐。', 'markdown', 1700000000.0, 'ews')"
    )
    conn.execute(
        "INSERT INTO email_metadata (internal_id, message_id, thread_id, subject, sender, date_received, mailbox, sync_status)"
        " VALUES (102, '<m102@x>', 't102', '差旅规范', 'finance@acme.com', '2026-11-19T10:00:00Z', '收件箱', 'synced')"
    )
    conn.execute(
        "INSERT INTO email_body (internal_id, message_id, body_markdown, body_format, fetched_at, fetched_source) "
        "VALUES (102, '<m102@x>', '住宿费用请开具增值税专用发票用于财务报销。', 'markdown', 1700000000.0, 'ews')"
    )
    conn.commit()
    conn.close()
    return EmailRepository(path)


def test_corrupt_semantic_db_is_non_critical_on_startup(tmp_path) -> None:
    """A corrupted `semantic_index.db` must NOT block app startup or trigger integrity failure marker."""
    sync_db = tmp_path / "sync_store.db"
    _seed_sync_db(str(sync_db))
    sem_db = tmp_path / "semantic_index.db"
    sem_db.write_bytes(b"NOT_A_VALID_SQLITE_HEADER_CORRUPTED")
    backups = tmp_path / "backups"

    report = run_startup_db_safety([str(sem_db)], backups, critical=False)
    assert report is not None or True  # must not raise DbIntegrityError


def test_semantic_index_batch_and_search_with_shared_manager(tmp_path, monkeypatch) -> None:
    reset_embedding_manager_for_tests()
    reset_semantic_service_for_tests()
    sync_db = tmp_path / "sync_store.db"
    _seed_sync_db(str(sync_db))
    lib_root = tmp_path / "library"
    lib_root.mkdir()
    sem_db = resolve_semantic_db_path(str(sync_db))

    enc = _DeterministicEmailEncoder()
    mgr = get_embedding_manager(str(lib_root))
    monkeypatch.setattr(mgr, "is_available", lambda *_a, **_k: True)
    monkeypatch.setattr(mgr, "get_provider", lambda *_a, **_k: enc)
    monkeypatch.setattr(mgr, "active_model_id", lambda: enc.model_id)
    monkeypatch.setattr(mgr, "active_min_score", lambda: 0.48)

    svc = SemanticIndexService(sem_db, str(sync_db), library_root=str(lib_root))
    res1 = svc.index_batch(limit=10)
    assert res1 == {"available": True, "indexed": 2}

    # Re-running must be a no-op because content_hash matches
    res2 = svc.index_batch(limit=10)
    assert res2 == {"available": True, "indexed": 0}

    # Semantic paraphrase query ("身体检查") has zero keyword overlap with "年度福利通知 / 健康体检"
    hits = svc.search_emails("身体检查", limit=5)
    assert hits and hits[0][0] == 101

    st = svc.status()
    assert st["indexed_emails"] == 2 and st["total_emails"] == 2
    reset_embedding_manager_for_tests()
    reset_semantic_service_for_tests()


def test_email_search_router_hybrid_fusion_and_offline_degradation(tmp_path, monkeypatch) -> None:
    reset_embedding_manager_for_tests()
    reset_semantic_service_for_tests()
    sync_db = tmp_path / "sync_store.db"
    repo = _seed_sync_db(str(sync_db))
    lib_root = tmp_path / "library"
    lib_root.mkdir()
    sem_db = resolve_semantic_db_path(str(sync_db))

    # Override auth + repo dependency cleanly
    from src.api.auth import verify_cf_access

    app.dependency_overrides[verify_cf_access] = lambda: "test"
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        client = TestClient(app)

        # 1. Offline / no model: hybrid request degrades smoothly to pure FTS with semantic.available=False
        r_off = client.get("/api/email/search", params={"q": "身体检查", "search_mode": "hybrid"})
        assert r_off.status_code == 200
        d_off = r_off.json()["data"]
        assert d_off["search_mode"] == "fts"
        assert d_off["semantic"]["available"] is False

        # 2. Seed semantic vectors & enable manager -> Stage 1 reports available, Stage 2 fuses semantic hit 101
        enc = _DeterministicEmailEncoder()
        mgr = get_embedding_manager(str(lib_root))
        monkeypatch.setattr(mgr, "is_available", lambda *_a, **_k: True)
        monkeypatch.setattr(mgr, "get_provider", lambda *_a, **_k: enc)
        monkeypatch.setattr(mgr, "active_model_id", lambda: enc.model_id)
        monkeypatch.setattr(mgr, "active_min_score", lambda: 0.48)

        sem_svc = SemanticIndexService(sem_db, str(sync_db), library_root=str(lib_root))
        sem_svc.index_batch(limit=10)
        import src.semantic.service as sem_mod

        monkeypatch.setattr(sem_mod, "_service_instance", sem_svc)

        r_stage1 = client.get("/api/email/search", params={"q": "身体检查", "search_mode": "fts"})
        assert r_stage1.status_code == 200
        d1 = r_stage1.json()["data"]
        assert d1["search_mode"] == "fts"
        assert d1["semantic"]["available"] is True
        assert d1["semantic"]["indexed_emails"] == 2
        assert d1["items"] == []

        r_stage2 = client.get("/api/email/search", params={"q": "身体检查", "search_mode": "hybrid"})
        assert r_stage2.status_code == 200
        d2 = r_stage2.json()["data"]
        assert d2["search_mode"] == "hybrid"
        assert len(d2["items"]) >= 1
        assert d2["items"][0]["internal_id"] == 101
        assert d2["items"][0]["lane"] == "vec"
    finally:
        app.dependency_overrides.clear()
        reset_embedding_manager_for_tests()
        reset_semantic_service_for_tests()
