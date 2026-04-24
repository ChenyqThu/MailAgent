"""High-level runner: given an internal_id, do the whole LLM+Notion cycle.

This is what both the main watcher hook and the CLI call.

Steps:
  1. SQLite lookup: get notion_page_id + mailbox + message_id for the email
  2. AppleScript: fetch MIME source via internal_id (~1s)
  3. reader.parse_email_source → Email obj
  4. LLMProcessor.process_email → AILabels
  5. AIFieldsWriter.write → pages.update (unless dry_run)
  6. LLMProcessingStore.mark_success / mark_failed
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, is_dataclass
from typing import Any, Dict, Optional

from loguru import logger

from src.config import config as cfg
from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader

from .client import LLMCallError
from .notion_writer import AIFieldsWriter
from .processor import LLMProcessor
from .store import LLMProcessingStore


def _lookup_by_internal_id(
    internal_id: int, db_path: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    path = db_path or cfg.sync_store_db_path
    with sqlite3.connect(path) as c:
        c.row_factory = sqlite3.Row
        row = c.execute(
            """
            SELECT internal_id, message_id, notion_page_id, mailbox, subject,
                   is_read, is_flagged
              FROM email_metadata
             WHERE internal_id = ?
            """,
            (internal_id,),
        ).fetchone()
        return dict(row) if row else None


class LLMRunner:
    """Reusable runner; keep one instance per long-running process."""

    def __init__(
        self,
        processor: Optional[LLMProcessor] = None,
        writer: Optional[AIFieldsWriter] = None,
        store: Optional[LLMProcessingStore] = None,
    ):
        self._processor = processor or LLMProcessor()
        self._writer = writer or AIFieldsWriter()
        self._store = store or LLMProcessingStore()
        self._arm: Optional[AppleScriptArm] = None
        self._reader: Optional[EmailReader] = None

    async def close(self):
        try:
            await self._processor.close()
        except Exception:
            pass

    def _lazy_arm(self) -> AppleScriptArm:
        if self._arm is None:
            self._arm = AppleScriptArm()
        return self._arm

    def _lazy_reader(self) -> EmailReader:
        if self._reader is None:
            self._reader = EmailReader()
        return self._reader

    async def run_for_internal_id(
        self,
        internal_id: int,
        *,
        dry_run: bool = False,
        overwrite: bool = True,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Process one email end-to-end.

        - force=False: if llm_processing already shows `success` for this
          internal_id, short-circuit and return.
        - dry_run=True: run LLM but do not touch Notion.
        - overwrite=True: LLM output wins over any existing field values.
        """
        meta = _lookup_by_internal_id(internal_id)
        if not meta:
            return {"ok": False, "internal_id": internal_id, "error": "not found in sync_store"}

        notion_page_id = meta.get("notion_page_id") or ""
        mailbox = meta.get("mailbox") or "收件箱"
        message_id = meta.get("message_id") or ""
        is_read = bool(meta.get("is_read"))
        is_flagged = bool(meta.get("is_flagged"))

        if not notion_page_id:
            return {
                "ok": False, "internal_id": internal_id,
                "error": "email not synced to Notion yet (notion_page_id empty)",
            }

        if not force:
            existing = self._store.get(internal_id)
            if existing and existing.get("status") == "success":
                return {
                    "ok": True, "internal_id": internal_id,
                    "skipped": "already_success",
                    "stored_at": existing.get("updated_at"),
                }

        # --- 1. fetch MIME ---
        arm = self._lazy_arm()
        full = arm.fetch_email_content_by_id(internal_id, mailbox)
        if not full:
            err = f"AppleScript fetch failed for internal_id={internal_id}"
            logger.warning(f"[llm-runner] {err}")
            return {"ok": False, "internal_id": internal_id, "error": err}

        # --- 2. parse Email ---
        reader = self._lazy_reader()
        email_obj = reader.parse_email_source(
            full.get("source", ""),
            message_id or full.get("message_id") or "",
            is_read=is_read,
            is_flagged=is_flagged,
        )
        if email_obj is None:
            err = f"parse_email_source returned None for internal_id={internal_id}"
            logger.warning(f"[llm-runner] {err}")
            return {"ok": False, "internal_id": internal_id, "error": err}

        # Populate mailbox + internal_id on the parsed obj (parser may not set)
        if not getattr(email_obj, "mailbox", None):
            try:
                email_obj.mailbox = mailbox
            except Exception:
                pass
        try:
            email_obj.internal_id = internal_id
        except Exception:
            pass

        # --- 3. LLM ---
        self._store.mark_pending(internal_id, notion_page_id, mailbox)
        try:
            labels = await self._processor.process_email(email_obj)
        except LLMCallError as e:
            info = self._store.mark_failed(
                internal_id, str(e), max_retries=cfg.llm_max_retries
            )
            logger.warning(f"[llm-runner] LLM failed: {info}")
            return {"ok": False, "internal_id": internal_id, "error": str(e), **info}
        except Exception as e:
            info = self._store.mark_failed(
                internal_id, repr(e), max_retries=cfg.llm_max_retries
            )
            logger.warning(f"[llm-runner] LLM unexpected error: {info}")
            return {"ok": False, "internal_id": internal_id, "error": repr(e), **info}

        # --- 4. write Notion (unless dry-run) ---
        try:
            summary = await self._writer.write(
                notion_page_id, labels, overwrite=overwrite, dry_run=dry_run
            )
        except Exception as e:
            info = self._store.mark_failed(
                internal_id, f"notion write failed: {e!r}",
                max_retries=cfg.llm_max_retries,
            )
            logger.warning(f"[llm-runner] Notion write failed: {info}")
            return {"ok": False, "internal_id": internal_id, "error": repr(e), **info}

        if not dry_run:
            self._store.mark_success(internal_id, labels, page_id=notion_page_id)

        return {
            "ok": True,
            "internal_id": internal_id,
            "page_id": notion_page_id,
            "mailbox": mailbox,
            "dry_run": dry_run,
            "labels": labels.summary_for_log(),
            "writer_summary": summary,
        }
