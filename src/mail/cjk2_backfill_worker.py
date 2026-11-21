"""2 字 CJK bigram 并行 FTS5 表（v75）的后台增量回填 worker。

``SyncStore._init_database_impl`` 在 v75 迁移块里只建空虚表（<50ms，不阻塞开窗 waitReady），
并在存在存量邮件/附件时将 ``sync_state['cjk2_backfill_done'] = '0'``。本 worker 在后台
分批读取存量正文与附件抽取文本，在事务外用 ``extract_cjk_bigrams`` 生成 2-gram 词元，
再以极短 ``BEGIN IMMEDIATE`` 事务幂等写入，批间让出控制权。全部回填完毕后置位 ``'1'``，
此后 2 字纯 CJK 搜索即无缝切入 FTS5 倒排索引。
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from typing import Any, Optional

from loguru import logger

from src.repository.cjk_bigram import extract_cjk_bigrams


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _get_state(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row and row[0] is not None else None


def _set_state(conn: sqlite3.Connection, key: str, value: str, now: float) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)",
        (key, value, now),
    )


def _should_stop(shutdown_event: Optional[Any]) -> bool:
    return bool(shutdown_event is not None and shutdown_event.is_set())


def backfill_once(
    db_path: str,
    *,
    batch_size: int = 200,
    yield_sec: float = 0.05,
    shutdown_event: Optional[Any] = None,
) -> dict[str, Any]:
    """幂等执行增量回填直至完成（或遇到关闭信号提前退出）。"""
    t0 = time.monotonic()
    bodies_done = 0
    attachments_done = 0

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        if not (
            _table_exists(conn, "sync_state")
            and _table_exists(conn, "email_body_fts_cjk2")
            and _table_exists(conn, "email_attachment_fts_cjk2")
        ):
            return {"done": False, "bodies": 0, "attachments": 0, "skipped": "no_v75_schema"}

        if _get_state(conn, "cjk2_backfill_done") == "1":
            return {"done": True, "bodies": 0, "attachments": 0}

        # ── 1. 邮件正文 + 主题 + 发件人 ─────────────────────────────────────
        while not _should_stop(shutdown_event):
            wm = int(_get_state(conn, "cjk2_body_watermark") or "0")
            rows = conn.execute(
                """SELECT b.internal_id, b.body_markdown, m.subject, m.sender
                     FROM email_body b
                     LEFT JOIN email_metadata m ON m.internal_id = b.internal_id
                    WHERE b.internal_id > ?
                    ORDER BY b.internal_id ASC
                    LIMIT ?""",
                (wm, batch_size),
            ).fetchall()
            if not rows:
                break

            prepared = [
                (
                    int(r["internal_id"]),
                    extract_cjk_bigrams(r["body_markdown"]),
                    extract_cjk_bigrams(r["subject"]),
                    extract_cjk_bigrams(r["sender"]),
                )
                for r in rows
            ]
            max_id = prepared[-1][0]

            conn.execute("BEGIN IMMEDIATE")
            try:
                if _get_state(conn, "cjk2_backfill_done") == "1":
                    conn.rollback()
                    return {"done": True, "bodies": bodies_done, "attachments": attachments_done}
                for iid, body_bg, subj_bg, sender_bg in prepared:
                    conn.execute("DELETE FROM email_body_fts_cjk2 WHERE rowid = ?", (iid,))
                    if body_bg or subj_bg or sender_bg:
                        conn.execute(
                            """INSERT INTO email_body_fts_cjk2
                               (rowid, body_bg, subject_bg, sender_bg)
                               VALUES (?, ?, ?, ?)""",
                            (iid, body_bg, subj_bg, sender_bg),
                        )
                cur_wm = int(_get_state(conn, "cjk2_body_watermark") or "0")
                _set_state(conn, "cjk2_body_watermark", str(max(cur_wm, max_id)), time.time())
                conn.commit()
            except Exception:
                conn.rollback()
                raise

            bodies_done += len(prepared)
            if yield_sec > 0:
                time.sleep(yield_sec)

        # ── 2. 附件文件名 + 已抽取正文 ──────────────────────────────────────
        while not _should_stop(shutdown_event):
            wm = int(_get_state(conn, "cjk2_att_watermark") or "0")
            rows = conn.execute(
                """SELECT t.attachment_id, t.text_content, COALESCE(a.filename, '') AS filename
                     FROM email_attachment_text t
                     JOIN email_attachment a ON a.id = t.attachment_id
                    WHERE t.status = 'extracted'
                      AND t.text_content IS NOT NULL
                      AND t.text_content != ''
                      AND t.attachment_id > ?
                    ORDER BY t.attachment_id ASC
                    LIMIT ?""",
                (wm, batch_size),
            ).fetchall()
            if not rows:
                break

            prepared_att = [
                (
                    int(r["attachment_id"]),
                    extract_cjk_bigrams(r["filename"]),
                    extract_cjk_bigrams(r["text_content"]),
                )
                for r in rows
            ]
            max_att_id = prepared_att[-1][0]

            conn.execute("BEGIN IMMEDIATE")
            try:
                if _get_state(conn, "cjk2_backfill_done") == "1":
                    conn.rollback()
                    return {"done": True, "bodies": bodies_done, "attachments": attachments_done}
                for att_id, fn_bg, txt_bg in prepared_att:
                    conn.execute("DELETE FROM email_attachment_fts_cjk2 WHERE rowid = ?", (att_id,))
                    if fn_bg or txt_bg:
                        conn.execute(
                            """INSERT INTO email_attachment_fts_cjk2
                               (rowid, filename_bg, text_bg)
                               VALUES (?, ?, ?)""",
                            (att_id, fn_bg, txt_bg),
                        )
                cur_wm = int(_get_state(conn, "cjk2_att_watermark") or "0")
                _set_state(conn, "cjk2_att_watermark", str(max(cur_wm, max_att_id)), time.time())
                conn.commit()
            except Exception:
                conn.rollback()
                raise

            attachments_done += len(prepared_att)
            if yield_sec > 0:
                time.sleep(yield_sec)

        if _should_stop(shutdown_event):
            return {"done": False, "bodies": bodies_done, "attachments": attachments_done}

        conn.execute("BEGIN IMMEDIATE")
        try:
            _set_state(conn, "cjk2_backfill_done", "1", time.time())
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            f"[cjk2-backfill] completed bodies={bodies_done} "
            f"attachments={attachments_done} elapsed={elapsed_ms}ms"
        )
        return {
            "done": True,
            "bodies": bodies_done,
            "attachments": attachments_done,
            "elapsed_ms": elapsed_ms,
        }
    finally:
        conn.close()


async def run_until_done(db_path: str, shutdown_event: asyncio.Event) -> None:
    """在 ``serve`` 主循环里作为独立异步任务跑完即止（绝不触发 supervise 重启循环）。"""
    try:
        await asyncio.to_thread(backfill_once, db_path, shutdown_event=shutdown_event)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 后台加速索引失败不影响邮件主同步（查询自动 fallback LIKE）
        logger.warning(f"[cjk2-backfill] failed (search falls back to LIKE): {exc}")


def start_background_thread(
    db_path: str, *, stop_event: Optional[threading.Event] = None
) -> Optional[threading.Thread]:
    """供 ``serve-api`` lifespan 一次性拉起的守护线程（已完成时零开销跳过）。"""
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            if not _table_exists(conn, "sync_state") or not _table_exists(
                conn, "email_body_fts_cjk2"
            ):
                return None
            if _get_state(conn, "cjk2_backfill_done") == "1":
                return None
        finally:
            conn.close()
    except sqlite3.Error:
        return None

    def _runner() -> None:
        try:
            backfill_once(db_path, shutdown_event=stop_event)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[cjk2-backfill] background thread failed: {exc}")

    t = threading.Thread(target=_runner, name="cjk2-backfill", daemon=True)
    t.start()
    return t
