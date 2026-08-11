"""Backfill builders — transport-neutral 取数 / 执行单元 (D2a 从 cli/commands/backfill.py 下沉)。

历史回填 (body / metadata) 的 candidate picker + unit builder + 单封
执行体。**纯 transport-neutral**: 只依赖 domain 层 (mail / notion / repository /
converter), 不 import cli / typer / output —— 故可被两个传输共用:

  - ``cli/commands/backfill.py`` (CLI 适配器): 命令体构造 arm/reader/repo/notion_sync,
    调本模块 builder 造 unit, 交 LongTaskContext 跑 + 渲染 CLI 输出。
  - ``sync/job_runners.py`` (engine 层 async_jobs 执行器): JobWorker 调本模块 builder
    造 unit, 交共享 LongTaskContext driver 跑。

分层 (D2a 决策, 见 docs/reference/architecture/backend-service-migration-matrix.md 进度日志):
  builder 是 sync-engine 的「取数 + 重 IO 执行单元」(sqlite / AppleScript / office
  convert / 写库), 与 fanout / job_runners 同属 engine 层 → 放 ``src/sync/`` 而非
  ``src/services/`` (后者只放写操作编排 + 守卫)。下沉消除了 ``job_runners`` 原先的
  lazy ``sync→cli`` 反向 import。``src/services/`` 的「零 cli import」不变式不受影响
  (本模块也不 import cli)。

逻辑一字未改 (D2a 整段搬迁): 行为 parity 由 tests/cli/test_backfill.py (CLI e2e) +
tests/sync/test_job_parity.py + tests/sync/test_job_worker.py (job runner) 锁定。
"""

from __future__ import annotations

import sqlite3
import time
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from src.mail.reader import EmailReader
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.repository import EmailRepository
from src.repository.storage_payload_builder import build_storage_payloads

if TYPE_CHECKING:
    from src.mail.backend.base import IMailBackend

_BackfillRecord = dict[str, Any]


# ============================================================
# Body backfill helpers
# ============================================================


def _ensure_dead_table(db_path: str) -> None:
    """Create the backfill-only dead-letter table."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS backfill_dead_ids (
                internal_id INTEGER PRIMARY KEY,
                error TEXT,
                marked_at REAL DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _mark_dead(db_path: str, internal_id: int, error: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO backfill_dead_ids "
            "(internal_id, error, marked_at) "
            "VALUES (?, ?, strftime('%s', 'now'))",
            (internal_id, (error or "")[:500]),
        )
        conn.commit()
    finally:
        conn.close()


def _reset_dead(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute("DELETE FROM backfill_dead_ids")
        conn.commit()
        return int(cur.rowcount)
    finally:
        conn.close()


def _dead_count(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM backfill_dead_ids").fetchone()[0])
    finally:
        conn.close()


def _list_dead(db_path: str, limit: int = 20) -> dict[str, Any]:
    _ensure_dead_table(db_path)
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT internal_id, error, marked_at FROM backfill_dead_ids "
            "ORDER BY marked_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        total = int(conn.execute("SELECT COUNT(*) FROM backfill_dead_ids").fetchone()[0])
    finally:
        conn.close()
    return {
        "action": "backfill-body",
        "mode": "inline",
        "total": total,
        "rows": [
            {"internal_id": r[0], "error": r[1] or "", "marked_at": r[2]}
            for r in rows
        ],
    }


_DEAD_ERROR_MARKERS = (
    "fetch_email_content_by_id returned None",
)


def _is_dead_error(err: str) -> bool:
    return any(marker in (err or "") for marker in _DEAD_ERROR_MARKERS)


def _pick_candidates(
    db_path: str,
    *,
    force: bool,
    since_date: Optional[str],
    until_date: Optional[str],
    mailbox: Optional[str],
    limit: Optional[int],
) -> list[_BackfillRecord]:
    """Select synced Notion emails that still need an SQLite body row."""
    _ensure_dead_table(db_path)
    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT m.internal_id, m.mailbox, m.message_id, m.is_read, m.is_flagged,
                   m.subject, m.date_received
              FROM email_metadata m
              LEFT JOIN email_body b ON m.internal_id = b.internal_id
              LEFT JOIN backfill_dead_ids d ON m.internal_id = d.internal_id
             WHERE m.sync_status = 'synced'
               AND m.notion_page_id IS NOT NULL
               AND d.internal_id IS NULL
        """
        params: list[Any] = []
        if not force:
            sql += " AND b.internal_id IS NULL"
        if since_date:
            sql += " AND m.date_received >= ?"
            params.append(since_date)
        if until_date:
            sql += " AND m.date_received <= ?"
            params.append(until_date)
        if mailbox:
            sql += " AND m.mailbox = ?"
            params.append(mailbox)
        sql += " ORDER BY m.date_received DESC"
        if limit is not None and limit > 0:
            sql += " LIMIT ?"
            params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        return [
            {
                "internal_id": int(r[0]),
                "mailbox": r[1] or "收件箱",
                "message_id": r[2],
                "is_read": bool(r[3]),
                "is_flagged": bool(r[4]),
                "subject": r[5] or "",
                "date": r[6] or "",
            }
            for r in rows
        ]
    finally:
        conn.close()


def _hydrate_internal_ids(ids: list[int], store: SyncStore) -> list[_BackfillRecord]:
    """Resolve explicit internal IDs through SyncStore metadata."""
    out: list[_BackfillRecord] = []
    for iid in ids:
        meta = store.get(iid)
        if not meta:
            logger.warning(f"internal_id={iid} not found in sync_store, skipping")
            continue
        out.append({
            "internal_id": iid,
            "mailbox": meta.get("mailbox") or "收件箱",
            "message_id": meta.get("message_id"),
            "is_read": bool(meta.get("is_read")),
            "is_flagged": bool(meta.get("is_flagged")),
            "subject": meta.get("subject") or "",
            "date": meta.get("date_received") or "",
        })
    return out


def _body_row_count(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM email_body").fetchone()[0])
    finally:
        conn.close()


def _source_text(source: Any) -> str:
    if isinstance(source, bytes):
        return source.decode("utf-8", errors="replace")
    return str(source or "")


def _backfill_one_body(
    record: _BackfillRecord,
    arm: "IMailBackend",
    reader: EmailReader,
    repo: EmailRepository,
    notion_sync: NotionSync,
    sync_store: SyncStore,
    *,
    db_path: str,
    dry_run: bool,
) -> dict[str, Any]:
    iid = int(record["internal_id"])
    mailbox = record["mailbox"]

    full = arm.fetch_email_content_by_id(iid, mailbox)
    if not full:
        error = "AppleScript fetch_email_content_by_id returned None"
        if not dry_run:
            _mark_dead(db_path, iid, error)
        return {
            "ok": True,
            "dead": True,
            "reason": error,
            "subject": str(record.get("subject") or "")[:60],
        }

    source = _source_text(full.get("source", ""))
    email = reader.parse_email_source(
        source,
        record.get("message_id") or full.get("message_id", ""),
        is_read=bool(record.get("is_read")),
        is_flagged=bool(record.get("is_flagged")),
    )
    if email is None:
        raise RuntimeError("parse_email_source returned None")

    email.mailbox = mailbox
    email.internal_id = iid

    # 此处原有一段搭车的 Office 派生（把 docx→pdf / xlsx→csv 追加进 email.attachments
    # 再一起落库）。2026-08 随 Notion 派生退役删除 —— 本函数的语义是「补正文」，派生
    # 只是搭了个便车。Office 派生本身已于 2026-08 整体退役（含 backfill derivatives 命令）。
    body, attachments = build_storage_payloads(
        email,
        iid,
        raw_mime_source=source,
        attachment_store=repo.attachment_store,
    )

    result = {
        "ok": True,
        "body_format": body.body_format,
        "body_size": len(body.markdown or ""),
        "html_size": len(body.html or ""),
        "attachments": len(attachments),
        "inline_images": body.has_inline_images,
    }
    if dry_run:
        result["dry_run"] = True
        return result

    id_map = repo.commit_email_with_body(
        iid, body, attachments, message_id=email.message_id,
    )
    result["attachment_ids"] = len(id_map)

    # 顺手补 email_metadata 的 MIME header 字段 (to/cc/sender_name/is_important).
    # SQLite radar 首次写入只能拿 internal_id + subject + sender + date; to/cc
    # 等 header 字段要等 reader 解析 MIME 才有, 历史一直漏写 (6000+ 封 to_addr
    # /cc_addr 全空). 既然 backfill body 已经把 MIME parse 出来了, 顺手把
    # metadata 也补了, 避免日后又要为同一份数据跑第二轮 backfill.
    metadata_patch: dict[str, Any] = {}
    if email.to:
        metadata_patch["to_addr"] = email.to
    if email.cc:
        metadata_patch["cc_addr"] = email.cc
    if email.sender_name:
        metadata_patch["sender_name"] = email.sender_name
    if email.is_important:
        metadata_patch["is_important"] = True
    if metadata_patch:
        try:
            sync_store.update_after_fetch(iid, metadata_patch)
            result["metadata_patched"] = sorted(metadata_patch.keys())
        except Exception as exc:  # noqa: BLE001 — metadata patch is best-effort
            logger.warning(f"[{iid}] metadata patch failed: {exc}")

    return result


def _make_body_units(
    records: list[_BackfillRecord],
    *,
    arm: "IMailBackend",
    reader: EmailReader,
    repo: EmailRepository,
    notion_sync: NotionSync,
    sync_store: SyncStore,
    db_path: str,
    dry_run: bool,
) -> list[tuple[int, Any]]:
    def _make_unit(record: _BackfillRecord):
        def _runner() -> dict[str, Any]:
            return _backfill_one_body(
                record,
                arm,
                reader,
                repo,
                notion_sync,
                sync_store,
                db_path=db_path,
                dry_run=dry_run,
            )

        return _runner

    return [(int(rec["internal_id"]), _make_unit(rec)) for rec in records]


# ============================================================
# Metadata backfill helpers — Notion API 反拉 to/cc/sender_name
# ============================================================


def _pick_metadata_candidates(
    db_path: str,
    *,
    force: bool,
    since_date: Optional[str],
    until_date: Optional[str],
    mailbox: Optional[str],
    limit: Optional[int],
) -> list[_BackfillRecord]:
    """挑选缺 to/cc/sender_name 任意一项且有 notion_page_id 的 synced 邮件."""
    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT internal_id, mailbox, message_id, is_read, is_flagged,
                   subject, date_received, notion_page_id,
                   to_addr, cc_addr, sender_name
              FROM email_metadata
             WHERE sync_status = 'synced'
               AND notion_page_id IS NOT NULL
        """
        params: list[Any] = []
        if not force:
            sql += """ AND (
                COALESCE(to_addr, '') = ''
                OR COALESCE(cc_addr, '') = ''
                OR COALESCE(sender_name, '') = ''
            )"""
        if since_date:
            sql += " AND date_received >= ?"
            params.append(since_date)
        if until_date:
            sql += " AND date_received <= ?"
            params.append(until_date)
        if mailbox:
            sql += " AND mailbox = ?"
            params.append(mailbox)
        sql += " ORDER BY date_received DESC"
        if limit is not None and limit > 0:
            sql += " LIMIT ?"
            params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        return [
            {
                "internal_id": int(r[0]),
                "mailbox": r[1] or "收件箱",
                "message_id": r[2],
                "is_read": bool(r[3]),
                "is_flagged": bool(r[4]),
                "subject": r[5] or "",
                "date": r[6] or "",
                "notion_page_id": r[7],
                "existing_to": r[8] or "",
                "existing_cc": r[9] or "",
                "existing_sender_name": r[10] or "",
            }
            for r in rows
        ]
    finally:
        conn.close()


def _hydrate_metadata_records(
    ids: list[int], store: SyncStore,
) -> list[_BackfillRecord]:
    out: list[_BackfillRecord] = []
    for iid in ids:
        meta = store.get(iid)
        if not meta:
            logger.warning(f"internal_id={iid} not found in sync_store, skipping")
            continue
        if not meta.get("notion_page_id"):
            logger.warning(f"internal_id={iid} has no notion_page_id, skipping")
            continue
        out.append({
            "internal_id": iid,
            "mailbox": meta.get("mailbox") or "收件箱",
            "message_id": meta.get("message_id"),
            "is_read": bool(meta.get("is_read")),
            "is_flagged": bool(meta.get("is_flagged")),
            "subject": meta.get("subject") or "",
            "date": meta.get("date_received") or "",
            "notion_page_id": meta.get("notion_page_id"),
            "existing_to": meta.get("to_addr") or "",
            "existing_cc": meta.get("cc_addr") or "",
            "existing_sender_name": meta.get("sender_name") or "",
        })
    return out


def _extract_notion_rich_text(props: dict[str, Any], name: str) -> str:
    prop = props.get(name) or {}
    rt = prop.get("rich_text", [])
    if not rt:
        return ""
    return "".join(t.get("text", {}).get("content", "") for t in rt)


# Notion REST 公布的速率限制约 3 req/s avg, 但 pages.retrieve 是热路径,
# 实际可以更激进 (实测 10-15 req/s 稳定). 节流跨 unit 调用, 给 _backfill_
# one_metadata 用; dry-run 走零延迟跳过.
_NOTION_PAGE_FETCH_DELAY_S = 0.05


def _backfill_one_metadata(
    record: _BackfillRecord,
    notion_client: Any,  # notion_client.Client (sync)
    sync_store: SyncStore,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    iid = int(record["internal_id"])
    page_id = record["notion_page_id"]
    page = notion_client.pages.retrieve(page_id=page_id)
    props = page.get("properties", {})

    to_addr = _extract_notion_rich_text(props, "To")
    cc_addr = _extract_notion_rich_text(props, "CC")
    sender_name = _extract_notion_rich_text(props, "From Name")

    patch: dict[str, Any] = {}
    if to_addr and to_addr != record.get("existing_to"):
        patch["to_addr"] = to_addr
    if cc_addr and cc_addr != record.get("existing_cc"):
        patch["cc_addr"] = cc_addr
    if sender_name and sender_name != record.get("existing_sender_name"):
        patch["sender_name"] = sender_name

    result: dict[str, Any] = {
        "ok": True,
        "page_id": page_id,
        "patched": sorted(patch.keys()),
        "to_len": len(to_addr),
        "cc_len": len(cc_addr),
        "sender_name_len": len(sender_name),
    }
    if not patch:
        result["skipped"] = "no_changes"
        return result
    if dry_run:
        result["dry_run"] = True
        return result

    sync_store.update_after_fetch(iid, patch)
    time.sleep(_NOTION_PAGE_FETCH_DELAY_S)
    return result


def _backfill_one_metadata_via_applescript(
    record: _BackfillRecord,
    arm: "IMailBackend",
    reader: EmailReader,
    sync_store: SyncStore,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    """AppleScript fetch + reader.parse 路径, 只写 metadata 不动 body / 附件.

    用于补 Notion 端也丢失 to/cc 的历史邮件 (NOTION_READ_FROM_SQLITE=true
    切换后 Notion 端 To/CC 也被 v4 路径覆写空). 跟 `backfill body --force`
    时间相当 (AppleScript fetch 是瓶颈, ~500ms-1s/封, 6300 封 ~1.5-2h),
    但不重写已有完整 body, 安全 + 不浪费 SQLite write IO.
    """
    iid = int(record["internal_id"])
    mailbox = record["mailbox"]
    full = arm.fetch_email_content_by_id(iid, mailbox)
    if not full:
        return {
            "ok": True,
            "skipped": "applescript_fetch_failed",
            "subject": str(record.get("subject") or "")[:60],
        }

    source = _source_text(full.get("source", ""))
    email = reader.parse_email_source(
        source,
        record.get("message_id") or full.get("message_id", ""),
        is_read=bool(record.get("is_read")),
        is_flagged=bool(record.get("is_flagged")),
    )
    if email is None:
        return {"ok": True, "skipped": "parse_failed"}

    patch: dict[str, Any] = {}
    if email.to:
        patch["to_addr"] = email.to
    if email.cc:
        patch["cc_addr"] = email.cc
    if email.sender_name:
        patch["sender_name"] = email.sender_name
    if email.is_important:
        patch["is_important"] = True

    result: dict[str, Any] = {
        "ok": True,
        "patched": sorted(patch.keys()),
        "to_len": len(email.to or ""),
        "cc_len": len(email.cc or ""),
        "sender_name_len": len(email.sender_name or ""),
        "is_important": bool(email.is_important),
    }
    if not patch:
        result["skipped"] = "no_data_in_mime"
        return result
    if dry_run:
        result["dry_run"] = True
        return result

    sync_store.update_after_fetch(iid, patch)
    return result


def _make_metadata_units(
    records: list[_BackfillRecord],
    *,
    source: str,
    notion_client: Optional[Any] = None,
    arm: Optional["IMailBackend"] = None,
    reader: Optional[EmailReader] = None,
    sync_store: SyncStore,
    dry_run: bool,
) -> list[tuple[int, Any]]:
    def _make_unit(record: _BackfillRecord):
        if source == "applescript":
            def _runner_as() -> dict[str, Any]:
                return _backfill_one_metadata_via_applescript(
                    record, arm, reader, sync_store, dry_run=dry_run,  # type: ignore[arg-type]
                )
            return _runner_as

        def _runner_notion() -> dict[str, Any]:
            return _backfill_one_metadata(
                record, notion_client, sync_store, dry_run=dry_run,
            )
        return _runner_notion
    return [(int(rec["internal_id"]), _make_unit(rec)) for rec in records]
