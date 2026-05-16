"""mailagent debug — 调试工具 (RFC v2 §4.11).

PR-3 US-008: 五个只读子命令.
- email-source       打印 / 保存邮件 raw MIME 源码 (从 AppleScript 重抽).
- mail-structure     列 Mail.app 所有 mailbox 名 + URL prefix.
- inline-images      分析单封邮件的 inline images / cid 引用.
- applescript-fetch  仅跑 AppleScriptArm.fetch_email_content_by_id, 绕开 SQLite.
- notion-page        Notion API 拉 page 的 properties summary.

全部 read-only, 不需 require_auth().
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
)
from src.cli.output import emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="debug",
    help="调试工具 (read-only, RFC §4.11)",
    no_args_is_help=True,
)


_VALID_LEAF_OUTPUT = ("text", "json", "yaml", "ndjson")


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
# email-source
# ============================================================

@app.command("email-source")
def debug_email_source(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    save_to: Optional[str] = typer.Option(
        None, "--save-to", help="保存到指定路径 (默认 stdout text / json size only)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """打印或保存邮件 raw MIME 源码 (AppleScript 重抽 — 绕开 SQLite SSoT)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    meta = cli.email_repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email metadata not found for internal_id={internal_id}",
        ))

    from src.mail.applescript_arm import AppleScriptArm

    arm = AppleScriptArm()
    try:
        full = arm.fetch_email_content_by_id(internal_id, meta.mailbox or "收件箱")
    except Exception as e:
        raise emit_cli_error(cli, CliNotFoundError(
            f"AppleScript fetch failed for internal_id={internal_id}: {e}",
            hint="Mail.app 可能不可达 / mailbox 不存在 / FDA 权限缺",
        ))

    if not full:
        raise emit_cli_error(cli, CliNotFoundError(
            f"No MIME source returned for internal_id={internal_id}",
        ))

    source = full.get("source", "") or ""
    size = len(source.encode("utf-8", errors="replace"))
    sha = hashlib.sha256(source.encode("utf-8", errors="replace")).hexdigest()

    if save_to:
        dest_path = Path(save_to).expanduser()
        if not dest_path.parent.exists():
            raise emit_cli_error(cli, CliInvalidArgError(
                f"Destination parent does not exist: {dest_path.parent}",
            ))
        dest_path.write_text(source, encoding="utf-8")
        data = {
            "internal_id": internal_id,
            "dest_path": str(dest_path.resolve()),
            "size_bytes": size,
            "sha256": sha,
            "message_id": full.get("message_id"),
        }
    else:
        data = {
            "internal_id": internal_id,
            "source": source,
            "size_bytes": size,
            "sha256": sha,
            "message_id": full.get("message_id"),
        }

    if cli.output.lower() == "text":
        if save_to:
            print(f"saved {size} bytes to {data['dest_path']} (sha256={sha[:12]}...)")
        else:
            print(source)
    else:
        emit(cli, data)


# ============================================================
# mail-structure
# ============================================================

@app.command("mail-structure")
def debug_mail_structure(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列 Mail.app 所有 mailbox 名 (调 AppleScript)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    from src.mail.applescript import AppleScriptExecutor

    script = (
        'tell application "Mail"\n'
        '    set accountNames to {}\n'
        '    repeat with theAccount in accounts\n'
        '        set end of accountNames to name of theAccount\n'
        '    end repeat\n'
        '    return accountNames\n'
        'end tell\n'
    )
    try:
        result = AppleScriptExecutor.execute(script)
    except Exception as e:
        raise emit_cli_error(cli, CliNotFoundError(
            f"AppleScript execution failed: {e}",
            hint="可能 Mail.app 未运行 / FDA 权限缺",
        ))

    accounts: list[str] = []
    if result:
        accounts = [n.strip() for n in result.split(",") if n.strip()]

    mb_script = (
        'tell application "Mail"\n'
        '    set boxNames to {}\n'
        '    repeat with mb in mailboxes\n'
        '        set end of boxNames to name of mb\n'
        '    end repeat\n'
        '    return boxNames\n'
        'end tell\n'
    )
    try:
        mb_result = AppleScriptExecutor.execute(mb_script)
    except Exception:
        mb_result = None

    mailboxes: list[str] = []
    if mb_result:
        mailboxes = [n.strip() for n in mb_result.split(",") if n.strip()]

    data = {
        "accounts": accounts,
        "mailboxes": mailboxes,
        "total_accounts": len(accounts),
        "total_mailboxes": len(mailboxes),
    }

    if cli.output.lower() == "text":
        print(f"accounts: {len(accounts)}")
        for a in accounts:
            print(f"  - {a}")
        print(f"mailboxes: {len(mailboxes)}")
        for m in mailboxes:
            print(f"  - {m}")
    else:
        emit(cli, data)


# ============================================================
# inline-images
# ============================================================

_CID_RE = re.compile(r'src=["\']?cid:([^"\'>\s]+)', re.IGNORECASE)


@app.command("inline-images")
def debug_inline_images(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """分析单封邮件的 inline images / cid 引用 (从 SQLite body_html + attachment)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    repo = cli.email_repo
    body = repo.get_body(internal_id)
    if body is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"No body in SQLite for internal_id={internal_id}",
            hint="可能未经 v4 双写; 跑 scripts/backfill_email_body.py 回填",
        ))

    html = body.html or ""
    cids = [m.group(1).strip() for m in _CID_RE.finditer(html)]
    unique_cids = list(dict.fromkeys(cids))  # 去重保序

    attachments = repo.get_attachments(internal_id)
    cid_to_att: dict[str, dict] = {}
    for att in attachments:
        if not att.content_id:
            continue
        # CID 可能带 <> 包裹, 也可能不带 — 双向尝试
        for key in (att.content_id, att.content_id.strip("<>")):
            cid_to_att[key] = {
                "attachment_id": att.id,
                "filename": att.filename,
                "is_inline": att.is_inline,
                "content_type": att.content_type,
            }

    inline_refs: list[dict] = []
    matched = 0
    for cid in unique_cids:
        att = cid_to_att.get(cid) or cid_to_att.get(cid.strip("<>"))
        ref = {"cid": cid, "matched": bool(att)}
        if att:
            ref.update(att)
            matched += 1
        inline_refs.append(ref)

    data = {
        "internal_id": internal_id,
        "body_format": body.body_format,
        "has_inline_images_flag": body.has_inline_images,
        "inline_refs": inline_refs,
        "total_refs": len(inline_refs),
        "total_matched": matched,
        "inline_attachments_total": sum(1 for a in attachments if a.is_inline),
    }

    if cli.output.lower() == "text":
        print(f"internal_id={internal_id} cid_refs={len(inline_refs)} matched={matched}")
        for r in inline_refs:
            tag = "*" if r["matched"] else "?"
            print(f"  [{tag}] cid={r['cid']} att={(r.get('filename') or '-')}")
    else:
        emit(cli, data)


# ============================================================
# applescript-fetch
# ============================================================

@app.command("applescript-fetch")
def debug_applescript_fetch(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    mailbox: Optional[str] = typer.Option(
        None, "--mailbox",
        help="覆盖 mailbox 名 (default: SQLite 中的 mailbox 字段)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """仅跑 AppleScriptArm.fetch_email_content_by_id (绕过 SQLite SSoT 路径)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    meta = cli.email_repo.get_metadata(internal_id)
    mb = mailbox or (meta.mailbox if meta else None) or "收件箱"

    from src.mail.applescript_arm import AppleScriptArm

    arm = AppleScriptArm()
    try:
        full = arm.fetch_email_content_by_id(internal_id, mb)
    except Exception as e:
        raise emit_cli_error(cli, CliNotFoundError(
            f"AppleScript fetch failed: {e}",
            hint="Mail.app 不可达 / mailbox 名错 / FDA 权限缺",
        ))

    found = bool(full)
    source = (full or {}).get("source", "") or ""
    size = len(source.encode("utf-8", errors="replace"))

    data = {
        "internal_id": internal_id,
        "mailbox": mb,
        "found": found,
        "source_size_bytes": size,
        "message_id": (full or {}).get("message_id"),
        "subject": (full or {}).get("subject"),
        "sender": (full or {}).get("sender"),
        "has_attachments": bool((full or {}).get("attachments")),
    }

    if cli.output.lower() == "text":
        print(f"internal_id={internal_id} mailbox={mb} found={found} size={size}")
        if found:
            print(f"  message_id={data['message_id']}")
            print(f"  subject={(data['subject'] or '')[:80]}")
            print(f"  sender={data['sender']}")
    else:
        emit(cli, data)


# ============================================================
# notion-page
# ============================================================

@app.command("notion-page")
def debug_notion_page(
    ctx: typer.Context,
    page_id: str = typer.Argument(..., help="Notion page id (with or without dashes)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Notion API 拉指定 page 的 properties summary (read-only)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    from src.notion.client import NotionClient

    client = NotionClient()
    try:
        page = asyncio.run(client.client.pages.retrieve(page_id=page_id))
    except Exception as e:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Notion pages.retrieve failed for {page_id}: {e}",
            hint="检查 page_id 是否正确 + NOTION_TOKEN 有读权限",
        ))
    finally:
        try:
            asyncio.run(client.close())
        except Exception:
            pass

    if not isinstance(page, dict):
        raise emit_cli_error(cli, CliNotFoundError(
            f"Unexpected response shape for {page_id}: {type(page).__name__}",
        ))

    # Properties summary — 只挑常用字段, 避免完整 dump (Notion property objects 庞大)
    props = page.get("properties") or {}
    summary: dict[str, object] = {}
    for key in (
        "Subject", "Message ID", "Thread ID", "From", "Date", "Mailbox",
        "Is Read", "Is Flagged", "Processing Status",
    ):
        prop = props.get(key)
        if prop is None:
            continue
        summary[key] = _summarize_property(prop)

    data = {
        "page_id": page.get("id"),
        "archived": page.get("archived"),
        "created_time": page.get("created_time"),
        "last_edited_time": page.get("last_edited_time"),
        "url": page.get("url"),
        "properties_summary": summary,
    }

    if cli.output.lower() == "text":
        print(f"page_id      {data['page_id']}")
        print(f"archived     {data['archived']}")
        print(f"created      {data['created_time']}")
        print(f"last_edited  {data['last_edited_time']}")
        print(f"url          {data['url']}")
        for k, v in summary.items():
            print(f"  {k}: {v}")
    else:
        emit(cli, data)


def _summarize_property(prop: dict) -> object:
    if not isinstance(prop, dict):
        return prop
    ptype = prop.get("type")
    if ptype == "title":
        return "".join(t.get("plain_text", "") for t in prop.get("title", []))
    if ptype == "rich_text":
        return "".join(t.get("plain_text", "") for t in prop.get("rich_text", []))
    if ptype == "email":
        return prop.get("email")
    if ptype == "date":
        d = prop.get("date") or {}
        return {"start": d.get("start"), "end": d.get("end")}
    if ptype == "select":
        s = prop.get("select") or {}
        return s.get("name") if s else None
    if ptype == "status":
        s = prop.get("status") or {}
        return s.get("name") if s else None
    if ptype == "checkbox":
        return bool(prop.get("checkbox"))
    return ptype
