"""mailagent notion — Notion 直接操作 (RFC v2 §4.6).

PR-3 US-005: resync (alias) / update-flag / archive
PR-3 US-006: page-orphans / file-link-audit
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.commands import email as _email_module
from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
)
from src.cli.output import emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="notion",
    help="Notion 直接操作 (resync alias / update-flag / archive / page-orphans / file-link-audit)",
    no_args_is_help=True,
)


_VALID_LEAF_OUTPUT = ("text", "json", "yaml", "ndjson")
PROCESSING_STATUS_ENUM = {
    "未处理", "AI Reviewed", "已同步", "已完成",
    "草稿已创建", "Reply Draft Created",
}


def _apply_local_output(ctx: typer.Context, output: Optional[str]) -> None:
    if output is None or ctx.obj is None:
        return
    if output.lower() not in _VALID_LEAF_OUTPUT:
        raise typer.BadParameter(
            f"--output must be one of {_VALID_LEAF_OUTPUT}, got {output!r}",
            param_hint="-o/--output",
        )
    ctx.obj.output = output.lower()


# ============================================================
# resync — alias to email resync (US-005)
# ============================================================

@app.command("resync")
def notion_resync(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    replace_existing: bool = typer.Option(False, "--replace-existing"),
    no_parent: bool = typer.Option(False, "--no-parent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Alias of ``mailagent email resync``; behaves identically (RFC §4.6 / §4.2)."""
    # 直接 delegate 到 email.email_resync — 同 flags / 同 auth / 同 schema
    _email_module.email_resync(
        ctx,
        internal_id=internal_id,
        dry_run=dry_run,
        replace_existing=replace_existing,
        no_parent=no_parent,
        output=output,
        range_=None, ids=None, max_failures=None,
        resume_from=None, progress_every=None,
    )


# ============================================================
# update-flag (US-005)
# ============================================================

@app.command("update-flag")
def notion_update_flag(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    is_read: Optional[str] = typer.Option(
        None, "--is-read", help="true / false",
    ),
    is_flagged: Optional[str] = typer.Option(
        None, "--is-flagged", help="true / false",
    ),
    processing_status: Optional[str] = typer.Option(
        None, "--processing-status",
        help="enum: 未处理 / AI Reviewed / 已同步 / 已完成 / 草稿已创建",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """手动改 Notion 邮件页 Is Read / Is Flagged / Processing Status (RFC §4.6)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if is_read is None and is_flagged is None and processing_status is None:
        raise emit_cli_error(cli, CliInvalidArgError(
            "at least one of --is-read / --is-flagged / --processing-status required",
        ))

    is_read_b = _parse_tribool(cli, is_read, "--is-read")
    is_flagged_b = _parse_tribool(cli, is_flagged, "--is-flagged")

    if processing_status is not None and processing_status not in PROCESSING_STATUS_ENUM:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--processing-status must be one of {sorted(PROCESSING_STATUS_ENUM)}, "
            f"got {processing_status!r}",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    meta = cli.email_repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email with internal_id={internal_id} not found in SQLite",
        ))
    if not meta.notion_page_id:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email internal_id={internal_id} has no Notion page (notion_page_id is null)",
            hint="先跑 mailagent email resync 同步到 Notion",
        ))

    props: dict = {}
    updated: dict = {}
    if is_read_b is not None:
        props["Is Read"] = {"checkbox": is_read_b}
        updated["Is Read"] = is_read_b
    if is_flagged_b is not None:
        props["Is Flagged"] = {"checkbox": is_flagged_b}
        updated["Is Flagged"] = is_flagged_b
    if processing_status is not None:
        props["Processing Status"] = {"status": {"name": processing_status}}
        updated["Processing Status"] = processing_status

    if dry_run:
        data = {
            "internal_id": internal_id,
            "page_id": meta.notion_page_id,
            "updated_properties": updated,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print(f"[dry-run] would update {meta.notion_page_id}:")
            for k, v in updated.items():
                print(f"  {k} = {v}")
        else:
            emit(cli, data)
        return

    # 实跑 — 调 NotionClient
    from src.notion.client import NotionClient

    client = NotionClient()
    try:
        asyncio.run(client.client.pages.update(
            page_id=meta.notion_page_id, properties=props,
        ))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"Notion API failed: {e}",
            hint="检查 NOTION_TOKEN + Page 是否存在",
        ))
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass

    data = {
        "internal_id": internal_id,
        "page_id": meta.notion_page_id,
        "updated_properties": updated,
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(f"updated page={meta.notion_page_id}: {updated}")
    else:
        emit(cli, data)


def _parse_tribool(cli, value: Optional[str], flag: str) -> Optional[bool]:
    if value is None:
        return None
    v = value.strip().lower()
    if v == "true":
        return True
    if v == "false":
        return False
    raise emit_cli_error(cli, CliInvalidArgError(
        f"{flag} expects true/false, got {value!r}",
    ))


# ============================================================
# archive (US-005)
# ============================================================

@app.command("archive")
def notion_archive(
    ctx: typer.Context,
    page_id: str = typer.Argument(..., help="Notion page id (with or without dashes)"),
    yes: bool = typer.Option(
        False, "--yes", "-y",
        help="确认 archive (默认拒, 避免误操作)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Archive 指定 Notion 页 (move to Trash). 必须 --yes 才生效."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not yes and not dry_run:
        raise emit_cli_error(cli, CliInvalidArgError(
            "archive is destructive; pass --yes to confirm, or --dry-run to preview",
        ))

    if dry_run:
        data = {"page_id": page_id, "dry_run": True, "action": "would_archive"}
        if cli.output.lower() == "text":
            print(f"[dry-run] would archive page_id={page_id}")
        else:
            emit(cli, data)
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    from src.notion.client import NotionClient

    client = NotionClient()
    try:
        asyncio.run(client.client.pages.update(page_id=page_id, archived=True))
    except Exception as e:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Notion archive failed for {page_id}: {e}",
            hint="检查 page_id 是否正确 + NOTION_TOKEN 有写权限",
        ))
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass

    data = {"page_id": page_id, "dry_run": False, "action": "archived"}
    if cli.output.lower() == "text":
        print(f"archived page_id={page_id}")
    else:
        emit(cli, data)


# ============================================================
# page-orphans (US-006)
# ============================================================

@app.command("page-orphans")
def notion_page_orphans(
    ctx: typer.Context,
    dry_run: bool = typer.Option(
        True, "--dry-run/--no-dry-run",
        help="PR-3 仅 dry-run (扫描不修复); 修复路径推迟 PR-4",
    ),
    limit: int = typer.Option(
        100, "--limit", help="最多扫 N 个 Notion page (避免超时)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """扫 Notion 邮件库有 page 但本地无 metadata 的孤儿 (RFC §4.6)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        raise emit_cli_error(cli, CliInvalidArgError(
            "page-orphans non-dry-run path not implemented in PR-3",
            hint="PR-3 只 audit 不修复; 修复留 PR-4 'admin repair-*'",
        ))

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))

    from src.notion.client import NotionClient

    # 拉本地已知 message_id 集合
    known_message_ids: set[str] = set()
    import sqlite3
    conn = sqlite3.connect(cli.cli_config.sync_store_db_path)
    try:
        for (mid,) in conn.execute(
            "SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL"
        ):
            known_message_ids.add(str(mid))
    finally:
        conn.close()

    client = NotionClient()
    orphans: list[dict] = []
    try:
        pages = asyncio.run(client.query_database(raise_on_error=False))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"Notion query_database failed: {e}",
            hint="检查 NOTION_TOKEN + EMAIL_DATABASE_ID",
        ))
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass

    total_scanned = 0
    for page in pages[:limit]:
        total_scanned += 1
        props = page.get("properties", {}) or {}
        msg_id_prop = props.get("Message ID") or {}
        msg_id = _extract_rich_text(msg_id_prop)
        subj_prop = props.get("Subject") or {}
        subject = _extract_title(subj_prop)
        if msg_id and msg_id in known_message_ids:
            continue
        page_id = page.get("id", "")
        notion_url = (
            f"https://www.notion.so/{page_id.replace('-', '')}"
            if page_id else None
        )
        orphans.append({
            "page_id": page_id,
            "message_id": msg_id or None,
            "subject": subject,
            "notion_url": notion_url,
        })

    data = {
        "orphans": orphans,
        "total_scanned": total_scanned,
        "total_orphans": len(orphans),
        "limit": limit,
        "dry_run": True,
    }

    if cli.output.lower() == "text":
        print(f"scanned={total_scanned} orphans={len(orphans)} (limit={limit})")
        for o in orphans:
            print(
                f"  page={o['page_id']} mid={o['message_id']} "
                f"subj={(o['subject'] or '')[:40]}"
            )
    else:
        emit(cli, data)


def _extract_rich_text(prop: dict) -> str:
    rt = prop.get("rich_text") or []
    parts = [item.get("plain_text", "") for item in rt]
    return "".join(parts).strip()


def _extract_title(prop: dict) -> str:
    t = prop.get("title") or []
    return "".join(item.get("plain_text", "") for item in t).strip()


# ============================================================
# file-link-audit (US-006)
# ============================================================

@app.command("file-link-audit")
def notion_file_link_audit(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(
        None, "--internal-id", help="仅审计单封 (默认扫全量 attachment)",
    ),
    limit: int = typer.Option(
        500, "--limit", help="最多扫 N 行 attachment (默认 500)",
    ),
    dry_run: bool = typer.Option(True, "--dry-run/--no-dry-run"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """审计 email_attachment.notion_file_id 状态 (PR-3 仅 dry-run, 不修复).

    判定:
      - notion_file_id NULL → 'missing_upload' (本地有附件但 Notion 未上传)
      - notion_file_id NOT NULL → 'ok' (PR-3 不真去 Notion 验存活, 留 PR-4)
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        raise emit_cli_error(cli, CliInvalidArgError(
            "file-link-audit non-dry-run path not implemented in PR-3",
            hint="PR-3 只标 missing_upload / ok; 修复路径留 PR-4",
        ))

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))

    if internal_id is not None:
        if cli.email_repo.get_metadata(internal_id) is None:
            raise emit_cli_error(cli, CliNotFoundError(
                f"internal_id={internal_id} not found in email_metadata",
            ))

    import sqlite3
    conn = sqlite3.connect(cli.cli_config.sync_store_db_path)
    conn.row_factory = sqlite3.Row
    try:
        if internal_id is not None:
            rows = conn.execute(
                """SELECT id, internal_id, filename, notion_file_id, notion_block_id
                   FROM email_attachment WHERE internal_id = ? LIMIT ?""",
                (internal_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, internal_id, filename, notion_file_id, notion_block_id
                   FROM email_attachment LIMIT ?""",
                (limit,),
            ).fetchall()
    finally:
        conn.close()

    audits = []
    by_status = {"missing_upload": 0, "ok": 0}
    for r in rows:
        status = "ok" if r["notion_file_id"] else "missing_upload"
        by_status[status] += 1
        audits.append({
            "attachment_id": int(r["id"]),
            "internal_id": int(r["internal_id"]),
            "filename": r["filename"],
            "status": status,
            "notion_file_id": r["notion_file_id"],
            "notion_block_id": r["notion_block_id"],
        })

    data = {
        "audits": audits,
        "total": len(audits),
        "by_status": by_status,
        "limit": limit,
        "internal_id_filter": internal_id,
        "dry_run": True,
    }

    if cli.output.lower() == "text":
        print(
            f"audits total={len(audits)} ok={by_status['ok']} "
            f"missing_upload={by_status['missing_upload']}"
        )
        for a in audits[:20]:
            print(
                f"  att_id={a['attachment_id']} iid={a['internal_id']} "
                f"file={(a['filename'] or '')[:40]} status={a['status']}"
            )
    else:
        emit(cli, data)
