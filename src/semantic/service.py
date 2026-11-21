"""Lightweight per-email single-vector semantic indexing & search service."""

from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import numpy as np
from loguru import logger

from src.embedding import get_embedding_manager, pack_bq, quantize_int8, two_stage_rank, unpack_bq_matrix
from src.semantic.db import SemanticDb, resolve_semantic_db_path
from src.semantic.repository import SemanticRepository

EMAIL_SNIPPET_MAX_CHARS = 500


def build_email_semantic_text(
    subject: Optional[str],
    sender: Optional[str],
    snippet: Optional[str],
    body_markdown: Optional[str],
) -> str:
    """Assemble lightweight 1-vector-per-email text (`subject + sender + summary[:500]`)."""
    subj = (subject or "").strip()
    snd = (sender or "").strip()
    excerpt = (snippet or body_markdown or "").strip()[:EMAIL_SNIPPET_MAX_CHARS]
    parts = [p for p in (subj, f"From: {snd}" if snd else "", excerpt) if p]
    return "\n".join(parts)


class SemanticIndexService:
    """Manages `<data>/semantic_index.db` independently of `sync_store.db::DB_VERSION`."""

    def __init__(
        self,
        semantic_db_path: str,
        sync_store_db_path: str,
        *,
        library_root: Optional[str] = None,
    ) -> None:
        self.db = SemanticDb(semantic_db_path)
        self.repo = SemanticRepository(self.db)
        self.sync_store_db_path = sync_store_db_path
        self.library_root = library_root or os.path.join(
            os.path.dirname(os.path.abspath(sync_store_db_path)), "library"
        )
        self._vec_cache: Optional[tuple[tuple[str, int, int, float], tuple[list[int], Any, Any]]] = None
        self._query_vec_cache: OrderedDict[str, Any] = OrderedDict()
        self._query_lock = threading.Lock()
        self._worker_running = False

    def _manager(self):
        return get_embedding_manager(self.library_root)

    def _ro_sync_conn(self) -> Optional[sqlite3.Connection]:
        if not self.sync_store_db_path or not os.path.isfile(self.sync_store_db_path):
            return None
        try:
            conn = sqlite3.connect(
                f"file:{os.path.abspath(self.sync_store_db_path)}?mode=ro",
                uri=True,
                timeout=10.0,
            )
            conn.row_factory = sqlite3.Row
            return conn
        except Exception:  # noqa: BLE001 — unreadable/absent sync DB degrades cleanly
            return None

    def _count_total_emails(self) -> int:
        sconn = self._ro_sync_conn()
        if sconn is None:
            return 0
        try:
            row = sconn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()
            return int(row[0]) if row else 0
        except Exception:  # noqa: BLE001 — test DBs without email_metadata return 0
            return 0
        finally:
            sconn.close()

    def status(self) -> dict[str, Any]:
        mgr = self._manager()
        available = mgr.is_available(self.library_root)
        model_id = mgr.active_model_id()
        indexed = 0
        try:
            conn = self.db.connect()
            try:
                indexed = self.repo.count_indexed(conn, model_id)
            finally:
                conn.close()
        except Exception:  # noqa: BLE001
            indexed = 0
        total = self._count_total_emails()
        return {
            "available": available,
            "model_id": model_id,
            "indexed_emails": indexed,
            "total_emails": total,
            "pending_emails": max(0, total - indexed),
            "running": self._worker_running,
        }

    def index_batch(self, *, limit: int = 32, recent_days: int = 90) -> dict[str, Any]:
        """Embed up to ``limit`` new or modified emails, prioritizing recent emails first."""
        mgr = self._manager()
        if not mgr.is_available(self.library_root):
            return {"available": False, "indexed": 0}
        provider = mgr.get_provider(self.library_root)
        if provider is None:
            return {"available": False, "indexed": 0}

        model_id = mgr.active_model_id()
        sconn = self._ro_sync_conn()
        if sconn is None:
            return {"available": True, "indexed": 0}

        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=recent_days)).strftime("%Y-%m-%d")
        conn = self.db.connect()
        try:
            existing = self.repo.existing_hashes(conn, model_id)
        finally:
            conn.close()

        candidates: list[tuple[int, str, str]] = []
        try:
            rows = sconn.execute(
                "SELECT m.internal_id, m.subject, m.sender, m.snippet, substr(COALESCE(b.body_markdown, ''), 1, 500) AS body_head"
                " FROM email_metadata m"
                " LEFT JOIN email_body b ON b.internal_id = m.internal_id"
                " ORDER BY CASE WHEN COALESCE(m.date_received, '') >= ? THEN 0 ELSE 1 END ASC, m.internal_id DESC",
                (cutoff_iso,),
            )
            for row in rows:
                iid = int(row["internal_id"])
                text = build_email_semantic_text(
                    row["subject"], row["sender"], row["snippet"], row["body_head"]
                )
                if not text:
                    continue
                chash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                if existing.get(iid) == chash:
                    continue
                candidates.append((iid, chash, text))
                if len(candidates) >= limit:
                    break
        except Exception as exc:  # noqa: BLE001 — tolerate bare schemas in unit tests
            logger.debug(f"[semantic] skipped batch scan: {exc}")
            return {"available": True, "indexed": 0}
        finally:
            sconn.close()

        if not candidates:
            return {"available": True, "indexed": 0}

        vectors = provider.encode([item[2] for item in candidates], batch_size=min(16, len(candidates)))
        now = time.time()
        vec_rows = []
        for (iid, chash, _text), vec in zip(candidates, vectors):
            vec_rows.append(
                {
                    "internal_id": iid,
                    "content_hash": chash,
                    "dim": int(vec.shape[0]),
                    "vec": quantize_int8(vec),
                    "bq_vec": pack_bq(vec),
                    "updated_at": now,
                }
            )
        with self.db.transaction() as wconn:
            written = self.repo.upsert_email_vecs(wconn, model_id, vec_rows)
        self._vec_cache = None
        return {"available": True, "indexed": written}

    def _encode_query_cached(self, provider: Any, model_id: str, query: str) -> Any:
        key = f"{model_id}:{query}"
        with self._query_lock:
            cached = self._query_vec_cache.get(key)
            if cached is not None:
                self._query_vec_cache.move_to_end(key)
                return cached
        qvec = provider.encode_query(query)
        with self._query_lock:
            self._query_vec_cache[key] = qvec
            self._query_vec_cache.move_to_end(key)
            while len(self._query_vec_cache) > 256:
                self._query_vec_cache.popitem(last=False)
        return qvec

    def _vectors(self, conn: sqlite3.Connection, model_id: str, fallback_dim: int) -> tuple[list[int], Any, Any]:
        sig = (model_id, *self.repo.vector_signature(conn, model_id))
        if self._vec_cache is not None and self._vec_cache[0] == sig:
            return self._vec_cache[1]
        ids, dims, blobs, bq_blobs = self.repo.load_vectors(conn, model_id)
        if blobs:
            eff_dim = dims[0] if dims else fallback_dim
            try:
                i8_mat = np.stack([np.frombuffer(b, dtype=np.int8) for b in blobs])
            except ValueError:
                rows = [np.frombuffer(b, dtype=np.int8)[:eff_dim] for b in blobs if len(b) >= eff_dim]
                i8_mat = np.stack(rows) if rows else np.zeros((0, eff_dim), dtype=np.int8)
        else:
            i8_mat = np.zeros((0, fallback_dim), dtype=np.int8)
        bq_mat = unpack_bq_matrix(bq_blobs, i8_mat)
        payload = (ids, i8_mat, bq_mat)
        self._vec_cache = (sig, payload)
        return payload

    def search_emails(self, query: str, *, limit: int = 30) -> list[tuple[int, float]]:
        """Return ranked ``(internal_id, score)`` hits, or ``[]`` when unavailable/empty."""
        if not query or not query.strip():
            return []
        mgr = self._manager()
        if not mgr.is_available(self.library_root):
            return []
        model_id = mgr.active_model_id()
        try:
            conn = self.db.connect()
            try:
                if self.repo.count_indexed(conn, model_id) == 0:
                    return []
                provider = mgr.get_provider(self.library_root)
                if provider is None:
                    return []
                qvec = self._encode_query_cached(provider, model_id, query.strip())
                ids, i8_mat, bq_mat = self._vectors(conn, model_id, mgr.active_dim())
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 — degrade cleanly to pure FTS
            logger.warning(f"[semantic] email vector query failed: {exc}")
            return []

        if not ids:
            return []
        ranked = two_stage_rank(
            qvec,
            i8_mat,
            bq_mat,
            top_k=limit,
            bq_candidates=max(100, limit * 4),
            min_score=mgr.active_min_score(),
        )
        return [(ids[idx], score) for idx, score in ranked]

    def start_background_worker(
        self,
        stop_event: threading.Event,
        *,
        batch_size: int = 32,
        batch_sleep_sec: float = 1.5,
        idle_sleep_sec: float = 60.0,
    ) -> threading.Thread:
        """Start low-priority background email indexer thread."""

        def _loop() -> None:
            self._worker_running = True
            try:
                while not stop_event.is_set():
                    try:
                        res = self.index_batch(limit=batch_size)
                        did_work = res.get("available") and int(res.get("indexed", 0)) > 0
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(f"[semantic] background index batch failed: {exc}")
                        did_work = False
                    stop_event.wait(batch_sleep_sec if did_work else idle_sleep_sec)
            finally:
                self._worker_running = False

        t = threading.Thread(target=_loop, name="email-semantic-index", daemon=True)
        t.start()
        return t


_service_lock = threading.Lock()
_service_instance: Optional[SemanticIndexService] = None


def get_semantic_service(
    sync_store_db_path: Optional[str] = None,
    *,
    library_root: Optional[str] = None,
) -> SemanticIndexService:
    global _service_instance
    resolved_sync = sync_store_db_path
    if not resolved_sync:
        try:
            from src.config import config as _cfg  # noqa: PLC0415

            resolved_sync = _cfg.sync_store_db_path
        except Exception:  # noqa: BLE001
            data_root = os.environ.get("MAILAGENT_DATA_ROOT") or "."
            resolved_sync = os.path.join(os.path.abspath(data_root), "data", "sync_store.db")

    sem_path = resolve_semantic_db_path(resolved_sync)
    with _service_lock:
        if (
            _service_instance is None
            or _service_instance.sync_store_db_path != resolved_sync
            or _service_instance.db.db_path != sem_path
        ):
            _service_instance = SemanticIndexService(
                sem_path, resolved_sync, library_root=library_root
            )
        return _service_instance


def reset_semantic_service_for_tests() -> None:
    global _service_instance
    with _service_lock:
        _service_instance = None
