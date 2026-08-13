"""mailagent contact — 通讯录 Contact Directory (task 08-13 WP1)。

Subcommands:
- ``backfill`` — 催跑 L0+L1 扫描 (watermark 消化到追平) + 聚合缓存校准/重算。
  与 new_watcher 后台节拍是**同一段代码** (src/contacts/scanner.py), 不另起
  bulk 路径; 全程幂等, ``--rescan`` 从 0 全量重扫 (应急回切 / SELF_EMAILS 改动
  后收敛历史口径用)。

写命令纪律: 真写需 token (``--dry-run`` 只报积压不写库、免 auth)。总闸
``MAILAGENT_CONTACTS_ENABLED`` off 时拒绝 (与后台扫描同一 inert 语义)。
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.output import apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="contact",
    help="通讯录: backfill (扫描催跑 + 聚合校准)",
    no_args_is_help=True,
)


@app.command("backfill")
def contact_backfill(
    ctx: typer.Context,
    rescan: bool = typer.Option(
        False, "--rescan",
        help="watermark 重置为 0 全量重扫 (幂等; 应急回切 / SELF_EMAILS 改动后用)",
    ),
    calibrate_only: bool = typer.Option(
        False, "--calibrate-only",
        help="跳过扫描, 只从账本重算聚合缓存 (mail_count / sent_to_count / 首末时间)",
    ),
    batch_size: int = typer.Option(500, "--batch-size", help="每批消化的邮件数"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="只报告积压量, 不写库 (免 auth)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """催跑通讯录扫描 (L0+L1) 并校准聚合缓存。"""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    if rescan and calibrate_only:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--rescan and --calibrate-only are mutually exclusive",
        ))
    if batch_size < 1:
        raise emit_cli_error(cli, CliInvalidArgError("--batch-size must be >= 1"))

    # CLI-scoped cfg (尊重 --config/--db-path override, 见 CliContext 的
    # _sync_global_cfg_from_cli 注记), 不读 import-time 全局单例。
    cfg = cli.cli_config
    if not getattr(cfg, "contacts_enabled", False):
        raise emit_cli_error(cli, CliError(
            "通讯录未启用 (MAILAGENT_CONTACTS_ENABLED=false) —— backfill 与后台"
            "扫描同一 inert 语义, 总闸关着不落库。",
            hint="在 .env 设 MAILAGENT_CONTACTS_ENABLED=true 并重启后端后再跑。",
        ))

    db_path = cfg.sync_store_db_path

    from src.contacts.repository import ContactRepository
    from src.contacts.scanner import WATERMARK_KEY, run_scan
    from src.contacts.service import recalc_all_aggregates, resolve_self_addresses

    if dry_run:
        with ContactRepository(db_path).connect() as conn:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key=?", (WATERMARK_KEY,)
            ).fetchone()
            watermark = int(row[0]) if row and str(row[0]).isdigit() else 0
            pending = conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE internal_id > ?",
                (0 if rescan else watermark,),
            ).fetchone()[0]
            contacts = conn.execute("SELECT COUNT(*) FROM contact").fetchone()[0]
        data = {
            "action": "contact-backfill", "dry_run": True, "rescan": rescan,
            "watermark": watermark, "pending": int(pending),
            "contacts": int(contacts),
        }
        _emit_result(cli, data)
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    started = time.monotonic()
    data: dict = {
        "action": "contact-backfill", "dry_run": False,
        "rescan": rescan, "calibrate_only": calibrate_only,
    }
    try:
        repository = ContactRepository(db_path)
        # self 集从 CLI-scoped cfg 解析 (不隐式读全局 settings)。
        with repository.connect() as conn:
            self_addresses = resolve_self_addresses(
                conn,
                user_email=getattr(cfg, "user_email", ""),
                extra_raw=getattr(cfg, "self_emails", ""),
            )
        if not calibrate_only:
            scan = run_scan(
                db_path, batch_size=batch_size, budget_sec=None,
                reset_watermark=rescan, self_addresses=self_addresses,
            )
            data["scan"] = scan
        with repository.transaction() as conn:
            data["calibrated_contacts"] = recalc_all_aggregates(
                conn, self_addresses=self_addresses, now=int(time.time() * 1000),
            )
    except CliError as e:
        raise emit_cli_error(cli, e)
    except Exception as e:
        raise emit_cli_error(cli, CliError(f"contact backfill failed: {e}"))
    data["duration_ms"] = int((time.monotonic() - started) * 1000)
    _emit_result(cli, data)


def _emit_result(cli: "CliContext", data: dict) -> None:
    if cli.output.lower() == "text":
        if data.get("dry_run"):
            print(
                f"dry-run  watermark={data['watermark']}  pending={data['pending']}  "
                f"contacts={data['contacts']}"
            )
            return
        scan = data.get("scan")
        if scan:
            print(
                f"scanned={scan['processed']}  skipped_draft={scan['skipped_draft']}  "
                f"contacts+={scan['contacts_created']}  links+={scan['links_inserted']}  "
                f"watermark={scan['watermark']}  drained={scan['drained']}"
            )
        print(
            f"calibrated_contacts={data['calibrated_contacts']}  "
            f"duration_ms={data['duration_ms']}"
        )
    else:
        emit(cli, data)
