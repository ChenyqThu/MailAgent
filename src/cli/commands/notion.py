"""mailagent notion — Notion 直接操作 (RFC v2 §4.6).

PR-3 US-005: resync (alias) / update-flag / archive
PR-3 US-006: page-orphans / file-link-audit
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.commands import email as _email_module
from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
)
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error
from src.notion.client import NotionClient

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="notion",
    help="Notion 直接操作 (resync alias / update-flag / archive / page-orphans / file-link-audit)",
    no_args_is_help=True,
)


PROCESSING_STATUS_ENUM = {
    "未处理", "AI Reviewed", "已同步", "已完成",
    "草稿已创建", "Reply Draft Created",
}


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

    # 实跑 — 调 NotionClient (透传 CLI cfg 而不是 import-time 全局 config, 让
    # --config / .env override 生效; PR-3 round-5 critic blocker #4 修复)
    from src.notion.client import NotionClient

    cfg = cli.cli_config
    client = NotionClient(token=cfg.notion_token, email_db_id=cfg.email_database_id)
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

    cfg = cli.cli_config
    client = NotionClient(token=cfg.notion_token, email_db_id=cfg.email_database_id)
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
        help="默认只扫描; --no-dry-run 必须配 repair flag + --yes",
    ),
    limit: int = typer.Option(
        100, "--limit", help="最多扫 N 个 Notion page (避免超时)",
    ),
    archive_orphan_pages: bool = typer.Option(
        False,
        "--archive-orphan-pages",
        help="非 dry-run: 在 Notion 上 archive 孤儿 page",
    ),
    insert_stub_metadata: bool = typer.Option(
        False,
        "--insert-stub-metadata",
        help="非 dry-run: 在 SQLite 创建 dead_letter stub metadata",
    ),
    max_pages: int = typer.Option(
        50, "--max-pages", help="实修上限 (避免误操作批量扩散)",
    ),
    yes: bool = typer.Option(False, "--yes", help="确认执行非 dry-run 修复"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """扫 Notion 邮件库有 page 但本地无 metadata 的孤儿 (RFC §4.6)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        if (not yes) or (archive_orphan_pages == insert_stub_metadata):
            raise emit_cli_error(cli, CliInvalidArgError(
                "Non-dry-run requires --yes and one of "
                "--archive-orphan-pages / --insert-stub-metadata (mutually exclusive)",
            ))

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))
    if max_pages <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--max-pages must be > 0, got {max_pages}",
        ))
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.notion.client import NotionClient

    # 拉本地已知 message_id 集合
    known_message_ids: set[str] = set()
    import sqlite3
    cfg = cli.cli_config
    conn = sqlite3.connect(cfg.sync_store_db_path)
    try:
        for (mid,) in conn.execute(
            "SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL"
        ):
            known_message_ids.add(str(mid))
    finally:
        conn.close()

    client = NotionClient(token=cfg.notion_token, email_db_id=cfg.email_database_id)
    try:
        # PRD §US-006: 真分页 (而不是只调 NotionClient.query_database 拿单页).
        # 直接走 client.client.data_sources.query 走 start_cursor / has_more.
        pages = asyncio.run(_paginated_query(client, limit))

        orphans: list[dict] = []
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

        if dry_run:
            data = {
                "orphans": orphans,
                "total_scanned": total_scanned,
                "total_orphans": len(orphans),
                "limit": limit,
                "dry_run": True,
                "mode": "dry_run",
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
            return

        to_repair = orphans[:max_pages]
        failed: list[dict] = []
        repaired_page_ids: list[str] = []
        if archive_orphan_pages:
            repaired_page_ids, failed = asyncio.run(
                _archive_orphan_pages(client, to_repair),
            )
            action_name = "archive"
        else:
            repaired_page_ids, failed = _insert_stub_metadata(
                cfg.sync_store_db_path, to_repair,
            )
            action_name = "insert-stub"

        data = {
            "action": action_name,
            "repair_action": action_name,
            "command": "page-orphans",
            "mode": "inline",
            "dry_run": False,
            "scanned": total_scanned,
            "orphans_found": len(orphans),
            "limit": limit,
            "max_pages": max_pages,
            "archived": repaired_page_ids,
            "failed": failed,
        }

        if cli.output.lower() == "text":
            print(
                f"action={action_name} scanned={total_scanned} "
                f"orphans={len(orphans)} repaired={len(repaired_page_ids)} "
                f"failed={len(failed)} max_pages={max_pages}"
            )
            for page_id in repaired_page_ids:
                print(f"  ok page={page_id}")
            for item in failed:
                print(f"  failed page={item['page_id']} error={item['error']}")
        else:
            emit(cli, data)
        if failed:
            raise typer.Exit(code=6)
    except Exception as e:
        if isinstance(e, typer.Exit):
            raise
        raise emit_cli_error(cli, CliError(
            f"Notion page-orphans failed: {e}",
            hint="检查 NOTION_TOKEN + EMAIL_DATABASE_ID",
        ))
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass


async def _archive_orphan_pages(client, orphans: list[dict]) -> tuple[list[str], list[dict]]:
    archived: list[str] = []
    failed: list[dict] = []
    for orphan in orphans:
        page_id = orphan["page_id"]
        try:
            await client.client.pages.update(page_id=page_id, archived=True)
            archived.append(page_id)
        except Exception as exc:
            failed.append({
                "page_id": page_id,
                "error": f"{type(exc).__name__}: {exc}",
            })
    return archived, failed


def _insert_stub_metadata(db_path: str, orphans: list[dict]) -> tuple[list[str], list[dict]]:
    from src.mail.sync_store import SyncStore

    store = SyncStore(db_path)
    inserted: list[str] = []
    failed: list[dict] = []
    for orphan in orphans:
        page_id = orphan["page_id"]
        try:
            internal_id = _derive_stub_internal_id(store, page_id)
            message_id = orphan.get("message_id") or f"orphan-{page_id}@stub"
            ok = store.save_email({
                "internal_id": internal_id,
                "message_id": message_id,
                "subject": (orphan.get("subject") or "")[:200],
                "sync_status": "dead_letter",
                "sync_error": "Orphan Notion page inserted as local stub metadata",
                "notion_page_id": page_id,
                "mailbox": "stub",
            })
            if not ok:
                raise RuntimeError("SyncStore.save_email returned False")
            inserted.append(page_id)
        except Exception as exc:
            failed.append({
                "page_id": page_id,
                "error": f"{type(exc).__name__}: {exc}",
            })
    return inserted, failed


def _derive_stub_internal_id(store, page_id: str) -> int:
    digest = hashlib.sha256(page_id.encode("utf-8")).digest()
    internal_id = -(int.from_bytes(digest[:8], "big") % 2_000_000_000 + 1)
    while store.get(internal_id) is not None:
        internal_id -= 1
    return internal_id


async def _paginated_query(client, limit: int) -> list[dict]:
    """Walk Notion data_sources.query 的 ``start_cursor`` / ``has_more`` 直到 limit 满 / 全扫完.

    单页 Notion API 默认 100 条; 比 NotionClient.query_database 的单调用更可靠
    (后者只返回一页, codex critic 提的 blocker).
    """
    ds_id = await client.get_data_source_id(client.email_db_id)
    results: list[dict] = []
    start_cursor: Optional[str] = None
    while len(results) < limit:
        params: dict = {"data_source_id": ds_id, "page_size": min(100, limit - len(results))}
        if start_cursor:
            params["start_cursor"] = start_cursor
        page = await client.client.data_sources.query(**params)
        rows = page.get("results", []) or []
        results.extend(rows)
        if not page.get("has_more"):
            break
        next_cur = page.get("next_cursor")
        if not next_cur:
            break
        start_cursor = next_cur
    return results[:limit]


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
    max_files: int = typer.Option(
        100, "--max-files", help="Repair upper bound on uploads (default 100)",
    ),
    archive_dead: bool = typer.Option(
        False,
        "--archive-dead",
        help="Also clear notion_file_id for dead links (best-effort)",
    ),
    yes: bool = typer.Option(False, "--yes", help="确认执行非 dry-run 修复"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """审计 / 修复 email_attachment.notion_file_id 状态.

    判定:
      - notion_file_id NULL → 'missing_upload' (本地有附件但 Notion 未上传)
      - notion_file_id NOT NULL → 'ok' (dead-link 检测当前仅 best-effort)
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        if not yes:
            raise emit_cli_error(cli, CliInvalidArgError(
                "Non-dry-run file-link-audit requires --yes confirmation",
            ))

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))
    if max_files <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--max-files must be > 0, got {max_files}",
        ))
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

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
                """SELECT id, internal_id, filename, local_path,
                          notion_file_id, notion_block_id
                   FROM email_attachment WHERE internal_id = ? LIMIT ?""",
                (internal_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, internal_id, filename, local_path,
                          notion_file_id, notion_block_id
                   FROM email_attachment LIMIT ?""",
                (limit,),
            ).fetchall()
    finally:
        conn.close()

    audits = []
    missing_uploads = []
    have_links = []
    by_status = {"missing_upload": 0, "ok": 0}
    for r in rows:
        status = "ok" if r["notion_file_id"] else "missing_upload"
        if status == "missing_upload":
            missing_uploads.append(r)
        else:
            have_links.append(r)
        by_status[status] += 1
        audits.append({
            "attachment_id": int(r["id"]),
            "internal_id": int(r["internal_id"]),
            "filename": r["filename"],
            "status": status,
            "notion_file_id": r["notion_file_id"],
            "notion_block_id": r["notion_block_id"],
        })

    if not dry_run:
        _repair_file_links(
            cli=cli,
            audits=audits,
            missing_uploads=missing_uploads,
            have_links=have_links,
            internal_id=internal_id,
            max_files=max_files,
            archive_dead=archive_dead,
        )
        return

    data = {
        "mode": "dry_run",
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


def _repair_file_links(
    *,
    cli: "CliContext",
    audits: list[dict],
    missing_uploads: list,
    have_links: list,
    internal_id: Optional[int],
    max_files: int,
    archive_dead: bool,
) -> None:
    """Upload local attachments missing Notion file ids and write ids back."""
    cfg = cli.cli_config
    repo = cli.email_repo
    client = NotionClient(token=cfg.notion_token, email_db_id=cfg.email_database_id)
    uploaded: list[dict] = []
    failed: list[dict] = []
    dead_archived: list[dict] = []

    async def _upload_all() -> None:
        upload_attempts = 0
        for r in missing_uploads:
            if upload_attempts >= max_files:
                break
            att_id = int(r["id"])
            local = r["local_path"]
            if not local:
                failed.append({
                    "attachment_id": att_id,
                    "error": "no local_path",
                })
                continue

            local_p = Path(local)
            if not local_p.is_absolute():
                local_p = Path.cwd() / local_p
            if not local_p.is_file():
                failed.append({
                    "attachment_id": att_id,
                    "error": f"file missing: {local_p}",
                })
                continue

            upload_attempts += 1
            try:
                file_id = await client.upload_file(str(local_p))
                repo.update_notion_links(
                    int(r["internal_id"]),
                    file_id_map={att_id: file_id},
                )
                uploaded.append({
                    "attachment_id": att_id,
                    "internal_id": int(r["internal_id"]),
                    "filename": r["filename"],
                    "notion_file_id": file_id,
                })
            except Exception as exc:
                failed.append({
                    "attachment_id": att_id,
                    "error": f"{type(exc).__name__}: {exc}",
                })

    try:
        if archive_dead and have_links:
            typer.echo(
                "warning: --archive-dead dead-link verification is not implemented; "
                "skipping Notion block walk",
                err=True,
            )
        asyncio.run(_upload_all())
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass

    data = {
        "action": "file-link-audit",
        "mode": "inline",
        "internal_id_filter": internal_id,
        "scanned": len(audits),
        "missing_upload_found": len(missing_uploads),
        "max_files": max_files,
        "archive_dead": archive_dead,
        "uploaded": uploaded,
        "dead_link_archived": dead_archived,
        "failed": failed,
        "dry_run": False,
    }

    if cli.output.lower() == "text":
        print(
            f"action=file-link-audit scanned={len(audits)} "
            f"missing_upload={len(missing_uploads)} uploaded={len(uploaded)} "
            f"failed={len(failed)} max_files={max_files}"
        )
        for item in uploaded:
            print(
                f"  uploaded att_id={item['attachment_id']} "
                f"iid={item['internal_id']} file={(item['filename'] or '')[:40]} "
                f"notion_file_id={item['notion_file_id']}"
            )
        for item in failed:
            print(f"  failed att_id={item['attachment_id']} error={item['error']}")
    else:
        emit(cli, data)
    if failed:
        raise typer.Exit(code=6)


# ============================================================
# create-task — 邮件转日程库 task (灵动岛 convert_to_notion_task, Phase 2 F3)
# LLM 决策 (task_extractor 单次 tool_use 填 title/time/类型/优先级) + 代码确定性写.
# 日程库 = CALENDAR_DATABASE_ID. 复用 calendar_notion/sync 的 data_source + pages.create 模式.
# ============================================================


def _task_content_blocks(email_page_id: str, subject: str, sender: str, description: str) -> list:
    """task page 正文: 来源邮件 callout + link_to_page + 行动要点段落."""
    blocks: list = []
    src = f"来自邮件: {subject or '(无主题)'}"
    if sender:
        src += f" · {sender}"
    blocks.append({
        "object": "block", "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {"content": src[:1800]}}],
            "icon": {"emoji": "📧"},
        },
    })
    if email_page_id:
        blocks.append({
            "object": "block", "type": "link_to_page",
            "link_to_page": {"type": "page_id", "page_id": email_page_id},
        })
    if description:
        blocks.append({
            "object": "block", "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": description[:1800]}}],
            },
        })
    return blocks


async def _write_task_page(cli, fields, email_page_id: str, subject: str, sender: str) -> dict:
    """写日程库 page: Title/日程类型/优先级/Time/Description + Email Inbox relation."""
    client = cli.notion_sync.client.client  # AsyncClient
    db_id = cli.cli_config.calendar_database_id
    db = await client.databases.retrieve(database_id=db_id)
    ds_list = db.get("data_sources") or []
    if not ds_list:
        raise RuntimeError(f"日程库 {db_id} 无 data_source")
    ds_id = ds_list[0]["id"]

    props: dict = {
        "Title": {"title": [{"text": {"content": fields.task_title}}]},
        "日程类型": {"select": {"name": fields.schedule_type}},
        "优先级": {"select": {"name": fields.priority}},
    }
    if fields.description:
        props["Description"] = {"rich_text": [{"text": {"content": fields.description}}]}
    if fields.suggested_time_iso:
        props["Time"] = {"date": {"start": fields.suggested_time_iso}}
    if fields.is_all_day:
        props["Is All Day"] = {"checkbox": True}
    if email_page_id:
        # Email Inbox relation 关联回原邮件 page (日程库 ↔ 邮件库 dual relation)
        props["Email Inbox"] = {"relation": [{"id": email_page_id}]}

    create_params: dict = {"parent": {"data_source_id": ds_id}, "properties": props}
    children = _task_content_blocks(email_page_id, subject, sender, fields.description)
    if children:
        create_params["children"] = children
    return await client.pages.create(**create_params)


async def _create_task_flow(
    cli, *, subject: str, body_md: str, ai_summary: str, ai_priority: str,
    sender: str, email_page_id: str, dry_run: bool, no_mark_done: bool,
    as_meeting: bool = False,
) -> dict:
    """单 asyncio.run 内: LLM extract → (非 dry-run) 写 task page → 标原邮件已完成.

    单 loop 包全部 async — 避免多次 asyncio.run 复用 AsyncClient 踩 loop 绑定坑.
    ``as_meeting=True`` (add_to_calendar): LLM 抽会议实际时间 + schedule_type 会议.
    """
    from loguru import logger
    from src.llm_agent.task_extractor import extract_task_fields

    fields = await extract_task_fields(
        subject=subject, body_markdown=body_md,
        ai_summary=ai_summary, ai_priority=ai_priority, sender=sender,
        as_meeting=as_meeting,
    )
    if dry_run:
        return {"fields": fields, "task_page_id": "", "marked_done": False}

    task_page = await _write_task_page(cli, fields, email_page_id, subject, sender)
    marked = False
    if not no_mark_done and email_page_id:
        try:
            await cli.notion_sync.update_page_mail_sync_status(
                email_page_id, synced=True, processing_status="已完成",
            )
            marked = True
        except Exception as e:  # noqa: BLE001 — task 已建, 标完成失败不致命
            logger.warning(f"[create-task] mark email done failed page={email_page_id[:12]}: {e}")
    return {"fields": fields, "task_page_id": task_page.get("id", ""), "marked_done": marked}


@app.command("create-task")
def notion_create_task(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="原邮件 internal_id"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="LLM 决策 + 打 plan, 不写 Notion (仍调一次 LLM)",
    ),
    no_mark_done: bool = typer.Option(
        False, "--no-mark-done", help="不把原邮件标 Processing Status=已完成",
    ),
    as_meeting: bool = typer.Option(
        False, "--as-meeting",
        help="会议模式 (灵动岛 add_to_calendar): LLM 抽邮件提到的会议实际时间 + "
             "schedule_type=工作·会议, 而非建议处理时间",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """邮件转日程库 (GTD 时间块) 的 task / 会议 — LLM 决策填字段 + 代码确定性写.

    灵动岛 (ping-island) convert_to_notion_task / add_to_calendar action handler 调.
    流程: internal_id → SQLite metadata + body → LLM extract_task (精炼 title /
    时间 / 日程类型 / 优先级 / description) → 写日程库 page (含 Email Inbox relation
    关联原邮件) → 标原邮件已完成.

    ``--as-meeting`` (add_to_calendar): LLM 抽邮件提到的会议实际时间 + 类型=会议;
    默认 (convert_to_notion_task): LLM 建议何时处理这个任务.

    日程库 = CALENDAR_DATABASE_ID. LLM 介入决策不介入执行 (单次 tool_use, ~$0.005).
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not cli.cli_config.calendar_database_id:
        raise emit_cli_error(cli, CliError(
            "CALENDAR_DATABASE_ID 未配置, 无法 create-task",
        ))

    record = cli.sync_store.get(internal_id)
    if not record:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email metadata not found for internal_id={internal_id}",
        ))

    subject = record.get("subject") or ""
    sender = record.get("sender") or ""
    email_page_id = (record.get("notion_page_id") or "").strip()
    ai_summary = record.get("ai_summary") or ""
    ai_priority = record.get("ai_priority") or ""
    body_md = ""
    try:
        body_md = cli.email_repo.get_body_markdown(internal_id, max_chars=8000) or ""
    except Exception:  # noqa: BLE001 — body miss 不致命, LLM 用 subject + summary
        pass

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.llm_agent.client import LLMCallError
    try:
        res = asyncio.run(_create_task_flow(
            cli, subject=subject, body_md=body_md, ai_summary=ai_summary,
            ai_priority=ai_priority, sender=sender, email_page_id=email_page_id,
            dry_run=dry_run, no_mark_done=no_mark_done, as_meeting=as_meeting,
        ))
    except LLMCallError as e:
        raise emit_cli_error(cli, CliError(f"LLM extract_task 失败: {e}"))
    except Exception as e:  # noqa: BLE001
        raise emit_cli_error(cli, CliError(f"create-task 失败: {e}"))

    fields = res["fields"]

    if dry_run:
        plan = {
            "internal_id": internal_id,
            "email_page_id": email_page_id,
            "task_title": fields.task_title,
            "schedule_type": fields.schedule_type,
            "priority": fields.priority,
            "suggested_time": fields.suggested_time_iso,
            "is_all_day": fields.is_all_day,
            "description": fields.description,
            "would_mark_done": not no_mark_done,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print("=== create-task plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:18} {value}")
        else:
            emit(cli, plan)
        return

    task_page_id = res["task_page_id"]
    data = {
        "internal_id": internal_id,
        "task_page_id": task_page_id,
        "task_url": f"https://www.notion.so/{task_page_id.replace('-', '')}" if task_page_id else "",
        "task_title": fields.task_title,
        "schedule_type": fields.schedule_type,
        "priority": fields.priority,
        "suggested_time": fields.suggested_time_iso,
        "marked_done": res["marked_done"],
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(
            f"task created: {fields.task_title} | {fields.schedule_type} | "
            f"{fields.priority} | {data['task_url']}"
        )
    else:
        emit(cli, data)
