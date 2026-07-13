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
from typing import Any, Dict, Optional

from loguru import logger

from src.config import config as cfg
from src.config import notion_enabled
from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.repository import AttachmentStore, EmailRepository, TranslationRepository

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
    """Reusable runner; keep one instance per long-running process.

    PR-3 CLI integration: 接受可选 ``db_path`` / ``attachment_storage_dir`` 让
    CLI ``--db-path`` / ``--config`` 真正生效 (不再被全局 ``cfg`` 旁路).
    向后兼容: 缺省时回退到 ``cfg.sync_store_db_path`` 等, 与旧 callers 一致。
    """

    def __init__(
        self,
        processor: Optional[LLMProcessor] = None,
        writer: Optional[AIFieldsWriter] = None,
        store: Optional[LLMProcessingStore] = None,
        repo: Optional[EmailRepository] = None,
        *,
        db_path: Optional[str] = None,
        attachment_storage_dir: Optional[str] = None,
        backend: Any = None,
    ):
        # v4 SSoT: 让 processor 优先读 SQLite markdown body。若未传 repo，
        # 默认基于 cfg 路径构造一个（让 CLI 也享受新路径，不增加调用方负担）。
        self._db_path_override = db_path  # None = 用 cfg 全局, 否则 CLI 注入
        effective_db_path = db_path or cfg.sync_store_db_path
        effective_attachment_dir = attachment_storage_dir or cfg.attachment_storage_dir

        if processor is None:
            if repo is None and cfg.llm_prefer_sqlite_body:
                try:
                    repo = EmailRepository(
                        db_path=effective_db_path,
                        attachment_store=AttachmentStore(effective_attachment_dir),
                    )
                except Exception as e:
                    logger.warning(f"[llm-runner] failed to init EmailRepository: {e}")
                    repo = None
            self._processor = LLMProcessor(repo=repo)
        else:
            self._processor = processor
        self._writer = writer or AIFieldsWriter()
        self._store = store or LLMProcessingStore(db_path=effective_db_path)
        self._arm: Optional[Any] = None
        # Sprint 16 dual-backend: 注入 backend 时直接用它抓 MIME (IMailBackend
        # Protocol 面). 没传 backend 时 fallback 老路径 lazy-init AppleScriptArm.
        self._backend = backend
        self._reader: Optional[EmailReader] = None
        # v12 沉浸式翻译: LLM 分类时 tool_use 顺带返回 translation_segments,
        # 在 mark_success 之前写入 email_translation 缓存表 (Path A)。
        # 失败静默 — 翻译是 nice-to-have, 不阻 LLM 分类主流程。
        self._translation_repo = TranslationRepository(db_path=effective_db_path)

    async def close(self):
        try:
            await self._processor.close()
        except Exception:
            pass

    def _lazy_arm(self):
        """返回 backend 对象, 满足 ``fetch_email_content_by_id(iid, mailbox)`` 契约.

        backend 注入时直接用它 (IMailBackend Protocol 面; davmail = IMAP UID FETCH,
        applescript = AppleScriptArm 委托). 没传 backend 且 applescript 模式:
        lazy-init AppleScriptArm (老路径行为不变)。没传 backend 但当前是 davmail
        模式: 拒绝兜底 —— 裸建 AppleScriptArm 会用 `whose id` 查一个 davmail id
        空间 (>=10^9) 的 internal_id, 必然查不到 (E1 §3.1 Step 3)。调用方应经
        src.mail.backend.factory.create_backend() 注入 backend。
        """
        if self._arm is not None:
            return self._arm
        if self._backend is not None:
            self._arm = self._backend
        elif getattr(cfg, "mailagent_backend", "applescript") == "davmail":
            raise RuntimeError(
                "LLMRunner backend not injected while MAILAGENT_BACKEND=davmail "
                "(AppleScriptArm fallback would query the wrong id space); caller "
                "must pass backend=create_backend(cfg, sync_store)"
            )
        else:
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
        meta = _lookup_by_internal_id(internal_id, db_path=self._db_path_override)
        if not meta:
            return {"ok": False, "internal_id": internal_id, "error": "not found in sync_store"}

        notion_page_id = meta.get("notion_page_id") or ""
        mailbox = meta.get("mailbox") or "收件箱"
        message_id = meta.get("message_id") or ""
        is_read = bool(meta.get("is_read"))
        is_flagged = bool(meta.get("is_flagged"))

        if not notion_page_id:
            # Notion 可选化（task 07-12 P3b 方案 C）：未配置 Notion 时本地-only 邮件
            # 天然无 page_id —— 分类照跑（SQLite 腿：labels/翻译/岛/飞书都消费 SQLite），
            # 仅跳过下方 Notion AI 字段回写腿。Notion 已配置时保持原语义（页未建先拒）。
            if notion_enabled():
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
        # page_id 空仅在 Notion disabled 时可达（enabled+空已在上方早退）→ 跳过回写腿。
        if notion_page_id:
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
        else:
            summary = {"skipped": "notion_disabled"}

        if not dry_run:
            self._store.mark_success(internal_id, labels, page_id=notion_page_id)
            # v12 Path A: LLM 分类顺带翻译写入缓存。仅在 LLM 返回 translation_segments
            # 且 language != '中文' 时写; processor._parse 已经做了 language 过滤,
            # 这里只需检查 segments 非空。任何失败 (FK / DB lock / json 等) silent
            # warning, 不冲掉 mark_success 的成功状态。
            if labels.translation_segments:
                try:
                    self._translation_repo.save_segments(
                        internal_id,
                        labels.translation_segments,
                        model=labels.model,
                        source="llm_agent",
                    )
                except Exception as e:
                    logger.warning(
                        f"[llm-runner] translation save failed for internal_id={internal_id}: {e}"
                    )

        return {
            "ok": True,
            "internal_id": internal_id,
            "page_id": notion_page_id,
            "mailbox": mailbox,
            "dry_run": dry_run,
            "labels": labels.summary_for_log(),
            "writer_summary": summary,
        }
