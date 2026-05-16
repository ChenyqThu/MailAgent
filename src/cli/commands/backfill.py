"""mailagent backfill — inline body / derivatives backfills (PR-5 US-001)."""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, TYPE_CHECKING

import typer
from loguru import logger

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.long_task import LongTaskContext, LongTaskSummary, UnitResult
from src.cli.output import apply_local_output, emit, emit_cli_error
from src.config import config as cfg
from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.repository import AttachmentStore, EmailRepository
from src.repository.storage_payload_builder import build_storage_payloads

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="backfill",
    help="历史回填工具 (body / derivatives)",
    no_args_is_help=True,
)

_BackfillRecord = dict[str, Any]
_DerivativeCandidate = tuple[int, int, str, str]


# ============================================================
# Shared CLI helpers
# ============================================================


def _common_auth_and_pm2(
    cli: "CliContext", *, dry_run: bool, allow_concurrent: bool,
) -> None:
    """Apply the write-command safety gate and render CliError consistently."""
    from src.cli.auth import require_auth_and_pm2

    try:
        require_auth_and_pm2(
            cli, dry_run=dry_run, allow_concurrent=allow_concurrent,
        )
    except CliError as exc:
        raise emit_cli_error(cli, exc)


def _parse_internal_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            ids.append(int(value))
        except ValueError as exc:
            raise CliInvalidArgError(
                f"invalid internal_id in --internal-ids: {value!r}"
            ) from exc
    if not ids:
        raise CliInvalidArgError("--internal-ids must contain at least one integer")
    return ids


def _body_target(
    *,
    all_: bool,
    internal_ids: Optional[str],
    since_date: Optional[str],
    until_date: Optional[str],
    mailbox: Optional[str],
    limit: Optional[int],
) -> tuple[str, str]:
    if internal_ids:
        ids = ",".join(str(i) for i in _parse_internal_ids(internal_ids))
        return "ids", f"ids:{ids}"
    if all_:
        return "all", "all"

    suffix = f":mailbox:{mailbox}" if mailbox else ""
    if since_date or until_date:
        key = f"date:{since_date or ''}..{until_date or ''}"
        if limit is not None:
            key += f":limit:{limit}"
        return "range", f"{key}{suffix}"
    if limit is not None:
        return "limit", f"limit:{limit}{suffix}"
    if mailbox:
        return "range", f"mailbox:{mailbox}"
    return "all", "all"


def _render_backfill_results(
    cli: "CliContext",
    results: list[UnitResult],
    summary: LongTaskSummary,
    *,
    action: str,
    dry_run: bool,
    target_kind: str,
    target_key: str,
) -> typer.Exit:
    """Render LongTaskContext output with the PR-5 backfill JSON contract.

    ``emit_long_task_results`` keeps caller metadata under ``meta``. PR-5's
    backfill contract needs ``data.mode`` and ``data.action``, so this mirrors
    the helper while keeping that data shape local to this command.
    """
    succeeded = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            **(r.data or {}),
        }
        for r in results if r.status == "success"
    ]
    failed = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            "error": {"code": r.error_code, "message": r.error_message},
        }
        for r in results if r.status == "failed"
    ]
    data = {
        "action": action,
        "mode": "inline",
        "dry_run": dry_run,
        "target_kind": target_kind,
        "target_key": target_key,
        "succeeded": succeeded,
        "failed": failed,
        "summary": summary.as_dict(),
    }
    meta = {
        "duration_ms": cli.elapsed_ms(),
        "aborted_by": summary.aborted_reason if summary.aborted else None,
    }
    status = _status_for_summary(summary)
    error = _error_for_summary(summary, failed)

    if cli.output.lower() == "ndjson":
        line = {"_meta": {**meta, **summary.as_dict(), "action": action, "mode": "inline"}}
        if error:
            line["_error"] = error
        print(json.dumps(line, ensure_ascii=False))
        return typer.Exit(code=summary.exit_code)

    if cli.output.lower() in ("json", "yaml"):
        wrapper: dict[str, Any] = {
            "status": status,
            "schema_version": 1,
            "data": data,
            "meta": meta,
        }
        if error:
            wrapper["error"] = error
        if cli.output.lower() == "json":
            print(json.dumps(wrapper, ensure_ascii=False, default=str))
        else:
            import yaml

            yaml.safe_dump(
                json.loads(json.dumps(wrapper, default=str)),
                sys.stdout, allow_unicode=True, sort_keys=False,
            )
        return typer.Exit(code=summary.exit_code)

    for item in succeeded:
        marker = "dead" if item.get("dead") else "ok"
        print(f"  {marker} {item['internal_id']} ({item.get('duration_ms', 0)}ms)")
    for item in failed:
        err = item["error"]
        print(
            f"  fail {item['internal_id']} ({item['duration_ms']}ms) "
            f"[{err['code']}] {err['message']}",
            file=sys.stderr,
        )
    print(
        f"[backfill] action={action} mode=inline total={summary.total} "
        f"succeeded={summary.succeeded} failed={summary.failed}",
        file=sys.stderr,
    )
    if error:
        print(f"Error [{error['code']}]: {error['message']}", file=sys.stderr)
    return typer.Exit(code=summary.exit_code)


def _status_for_summary(summary: LongTaskSummary) -> str:
    if summary.max_failures_hit or summary.aborted:
        return "error"
    if summary.failed > 0 and summary.succeeded > 0:
        return "partial_failure"
    if summary.failed > 0:
        return "error"
    return "success"


def _error_for_summary(
    summary: LongTaskSummary, failed: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if summary.max_failures_hit:
        return {
            "code": "E_MAX_FAILURES",
            "message": summary.aborted_reason or "max failures hit",
        }
    if summary.aborted:
        return {
            "code": "E_ABORTED",
            "message": summary.aborted_reason or "aborted",
        }
    if summary.failed > 0 and summary.succeeded == 0:
        first = failed[0]["error"] if failed else {}
        return {
            "code": first.get("code") or "E_INTERNAL",
            "message": first.get("message") or "all units failed",
        }
    return None


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
    arm: AppleScriptArm,
    reader: EmailReader,
    repo: EmailRepository,
    notion_sync: NotionSync,
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

    from src.converter.office_converter import is_convertible

    expected_convertibles = [
        att.filename for att in email.attachments if is_convertible(att.filename)
    ]
    try:
        derived = notion_sync._convert_office_attachments(email)
        if derived:
            email.attachments.extend(derived)
            derived_origins = {
                item.derived_from_filename
                for item in derived if item.derived_from_filename
            }
            missed = set(expected_convertibles) - derived_origins
            if missed:
                logger.warning(
                    f"[{iid}] Office convert produced no derivative for: {missed} "
                    f"(expected {len(expected_convertibles)}, got {len(derived_origins)})"
                )
        elif expected_convertibles:
            logger.warning(
                f"[{iid}] Office convert returned empty but "
                f"{len(expected_convertibles)} convertible attachments expected: "
                f"{expected_convertibles}"
            )
    except Exception as exc:  # noqa: BLE001 - conversion is a best-effort derivative
        logger.warning(f"[{iid}] Office pre-convert raised (non-fatal): {exc}")

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
    return result


def _make_body_units(
    records: list[_BackfillRecord],
    *,
    arm: AppleScriptArm,
    reader: EmailReader,
    repo: EmailRepository,
    notion_sync: NotionSync,
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
                db_path=db_path,
                dry_run=dry_run,
            )

        return _runner

    return [(int(rec["internal_id"]), _make_unit(rec)) for rec in records]


# ============================================================
# Derivative backfill helpers
# ============================================================


def _find_candidates(
    db_path: str, internal_id_filter: Optional[int] = None,
) -> list[_DerivativeCandidate]:
    """Find convertible attachments without a derived child row."""
    from src.converter.office_converter import is_convertible

    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT a.id, a.internal_id, a.filename, a.local_path
              FROM email_attachment a
             WHERE a.derived_from IS NULL
               AND a.local_path IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM email_attachment c
                  WHERE c.derived_from = a.id
               )
        """
        params: list[Any] = []
        if internal_id_filter is not None:
            sql += " AND a.internal_id = ?"
            params.append(internal_id_filter)
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [
        (int(r[0]), int(r[1]), r[2], r[3])
        for r in rows if is_convertible(r[2])
    ]


def _insert_derived(
    repo: EmailRepository,
    parent_att_id: int,
    parent_internal_id: int,
    derived_path: Path,
    derived_format: str,
) -> int:
    """Persist a derived file and add its email_attachment row."""
    content = derived_path.read_bytes()
    _target, used_filename = repo.attachment_store.save(
        parent_internal_id, derived_path.name, content,
    )
    sha = AttachmentStore.sha256(content)
    local_path = repo.attachment_store.relative_path(parent_internal_id, used_filename)

    content_type = "application/pdf" if derived_format == "pdf" else "text/csv"
    conn = sqlite3.connect(str(repo.db_path))
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        cur = conn.execute(
            """INSERT INTO email_attachment
               (internal_id, content_id, filename, content_type, size_bytes,
                is_inline, local_path, sha256, derived_from, derived_format,
                created_at, schema_version)
               VALUES (?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)""",
            (
                parent_internal_id,
                used_filename,
                content_type,
                len(content),
                local_path,
                sha,
                parent_att_id,
                derived_format,
                time.time(),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def _resolve_local_path(local_path: str) -> Path:
    path = Path(local_path)
    return path if path.is_absolute() else Path.cwd() / path


def _backfill_one_derivative(
    candidate: _DerivativeCandidate,
    repo: EmailRepository,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    from src.converter.office_converter import convert_office_attachment

    att_id, iid, filename, local_path = candidate
    result: dict[str, Any] = {
        "att_id": att_id,
        "filename": filename,
    }
    if dry_run:
        result["dry_run"] = True
        return result

    src_path = _resolve_local_path(local_path)
    if not src_path.is_file():
        raise FileNotFoundError(f"source file missing: {src_path}")
    src_bytes = src_path.read_bytes()

    inserted: list[int] = []
    with tempfile.TemporaryDirectory(prefix=f"derive-{iid}-") as tmp:
        tmp_dir = Path(tmp)
        tmp_src = tmp_dir / filename
        tmp_src.write_bytes(src_bytes)

        converted = convert_office_attachment(str(tmp_src), str(tmp_dir))
        if not converted:
            raise RuntimeError("conversion returned empty list")

        for converted_path in converted:
            path = Path(converted_path)
            derived_format = "pdf" if path.suffix.lower() == ".pdf" else "csv"
            new_id = _insert_derived(repo, att_id, iid, path, derived_format)
            inserted.append(new_id)
            logger.info(
                f"[att_id={att_id}->{new_id}] {filename} -> "
                f"{path.name} ({derived_format})"
            )

    result["derived_ids"] = inserted
    result["derived_count"] = len(inserted)
    return result


def _make_derivative_units(
    candidates: list[_DerivativeCandidate],
    *,
    repo: EmailRepository,
    dry_run: bool,
) -> list[tuple[int, Any]]:
    def _make_unit(candidate: _DerivativeCandidate):
        def _runner() -> dict[str, Any]:
            return _backfill_one_derivative(candidate, repo, dry_run=dry_run)

        return _runner

    return [(candidate[1], _make_unit(candidate)) for candidate in candidates]


# ============================================================
# backfill body
# ============================================================


@app.command("body")
def backfill_body(
    ctx: typer.Context,
    since_date: Optional[str] = typer.Option(
        None, "--since-date", help="YYYY-MM-DD",
    ),
    until_date: Optional[str] = typer.Option(
        None, "--until-date", help="YYYY-MM-DD",
    ),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    internal_ids: Optional[str] = typer.Option(
        None, "--internal-ids", help="逗号分隔的 internal_id 列表",
    ),
    all_: bool = typer.Option(
        False, "--all", help="全量回填 (与其他过滤互斥)",
    ),
    limit: Optional[int] = typer.Option(None, "--limit"),
    force: bool = typer.Option(False, "--force", help="覆盖已 backfilled 的邮件"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(
        20, "--max-failures", help="连续失败熔断阈值",
    ),
    progress_every: int = typer.Option(10, "--progress-every"),
    resume_from: Optional[int] = typer.Option(None, "--resume-from"),
    retry_dead: bool = typer.Option(False, "--retry-dead"),
    show_dead: bool = typer.Option(False, "--show-dead"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """v4 historical email body backfill, now executed inline."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    db_path = cli.cli_config.sync_store_db_path

    if show_dead:
        emit(cli, _list_dead(db_path))
        return

    other_filters = any(
        value is not None for value in (
            since_date, until_date, mailbox, internal_ids, limit,
        )
    )
    if all_ and other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--all is mutually exclusive with --since-date / --until-date / "
            "--mailbox / --internal-ids / --limit"
        ))
    if not all_ and not other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Provide --all or at least one filter (--since-date / --limit / etc.)"
        ))

    _common_auth_and_pm2(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    _ensure_dead_table(db_path)
    cleared_dead = _reset_dead(db_path) if retry_dead else 0

    if internal_ids:
        ids = _parse_internal_ids(internal_ids)
        records = _hydrate_internal_ids(ids, cli.sync_store)
    else:
        records = _pick_candidates(
            db_path,
            force=force,
            since_date=since_date,
            until_date=until_date,
            mailbox=mailbox,
            limit=limit,
        )

    target_kind, target_key = _body_target(
        all_=all_,
        internal_ids=internal_ids,
        since_date=since_date,
        until_date=until_date,
        mailbox=mailbox,
        limit=limit,
    )
    initial_body_count = _body_row_count(db_path)
    initial_dead_count = _dead_count(db_path)

    arm = AppleScriptArm(
        account_name=cfg.mail_account_name, inbox_name=cfg.mail_inbox_name,
    )
    reader = EmailReader()
    repo = EmailRepository(
        db_path=db_path,
        attachment_store=AttachmentStore(cli.cli_config.attachment_storage_dir),
    )
    notion_sync = NotionSync(email_repo=repo, sync_store=cli.sync_store)

    units = _make_body_units(
        records,
        arm=arm,
        reader=reader,
        repo=repo,
        notion_sync=notion_sync,
        db_path=db_path,
        dry_run=dry_run,
    )
    ltc = LongTaskContext(
        cli=cli,
        command="backfill-body",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),
        resume_from=resume_from,
        payload={
            "force": force,
            "mailbox": mailbox,
            "since_date": since_date,
            "until_date": until_date,
            "limit": limit,
            "retry_dead_cleared": cleared_dead,
            "initial_body_count": initial_body_count,
            "initial_dead_count": initial_dead_count,
        },
    )
    results, summary = ltc.run(units, dry_run=dry_run)
    raise _render_backfill_results(
        cli,
        results,
        summary,
        action="backfill-body",
        dry_run=dry_run,
        target_kind=target_kind,
        target_key=target_key,
    )


# ============================================================
# backfill derivatives
# ============================================================


@app.command("derivatives")
def backfill_derivatives(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(None, "--internal-id", help="仅补单封"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(20, "--max-failures"),
    progress_every: int = typer.Option(10, "--progress-every"),
    resume_from: Optional[int] = typer.Option(None, "--resume-from"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Backfill missing Office-derived attachment rows inline."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    db_path = cli.cli_config.sync_store_db_path

    _common_auth_and_pm2(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    candidates = _find_candidates(db_path, internal_id)
    repo = EmailRepository(
        db_path=db_path,
        attachment_store=AttachmentStore(cli.cli_config.attachment_storage_dir),
    )
    units = _make_derivative_units(candidates, repo=repo, dry_run=dry_run)
    target_kind = "ids" if internal_id is not None else "all"
    target_key = f"ids:{internal_id}" if internal_id is not None else "all"

    ltc = LongTaskContext(
        cli=cli,
        command="backfill-derivatives",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),
        resume_from=resume_from,
        payload={"internal_id": internal_id},
    )
    results, summary = ltc.run(units, dry_run=dry_run)
    raise _render_backfill_results(
        cli,
        results,
        summary,
        action="backfill-derivatives",
        dry_run=dry_run,
        target_kind=target_kind,
        target_key=target_key,
    )
