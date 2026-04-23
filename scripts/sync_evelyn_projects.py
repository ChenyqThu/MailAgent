#!/usr/bin/env python3
"""Evelyn 周项目邮件 → Notion 项目进度库同步 CLI。

用法:
    # 自动找最近一封未处理的
    python scripts/sync_evelyn_projects.py

    # 指定 internal_id
    python scripts/sync_evelyn_projects.py --internal-id 51793

    # 回填历史（按日期升序）
    python scripts/sync_evelyn_projects.py --all-history --limit 10

    # 干跑
    python scripts/sync_evelyn_projects.py --internal-id 51793 --dry-run

    # 强制重跑
    python scripts/sync_evelyn_projects.py --internal-id 51793 --force
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# 项目根
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from loguru import logger

from src.config import config  # noqa: E402
from src.evelyn_project.runner import EvelynProjectRunner, SyncSummary  # noqa: E402


def _setup_logger(verbose: bool) -> None:
    logger.remove()
    level = "DEBUG" if verbose else "INFO"
    logger.add(sys.stderr, level=level, format="{time:HH:mm:ss} {level} {message}")


async def _run(args: argparse.Namespace) -> int:
    runner = EvelynProjectRunner()
    targets: list[int] = []
    if args.internal_id:
        targets = [int(args.internal_id)]
    elif args.all_history:
        targets = runner.find_all_history(limit=args.limit)
        if not targets:
            logger.warning("No Evelyn emails found in SyncStore")
            return 0
        logger.info(f"Found {len(targets)} Evelyn emails: {targets}")
    else:
        latest = runner.find_latest_pending()
        if latest is None:
            # backfill 模式下用最近一封已处理的（有完整 xlsx）
            if args.backfill_project_start:
                last = runner.find_all_history(limit=1)
                if last:
                    targets = [last[-1]]
                    logger.info(f"backfill picks latest historical: internal_id={targets[0]}")
            if not targets:
                logger.info("No unprocessed Evelyn project email in SyncStore")
                return 0
        else:
            targets = [latest]
            logger.info(f"Auto-picked latest: internal_id={latest}")

    # Backfill 模式：只回填"项目开始时间"，不走完整 sync
    if args.backfill_project_start:
        for iid in targets:
            stats = await runner.backfill_project_start(
                internal_id=iid, dry_run=args.dry_run
            )
            logger.info(f"Backfill result: {stats}")
        return 0

    summaries: list[SyncSummary] = []
    for iid in targets:
        s = await runner.sync_from_email(
            internal_id=iid,
            force=args.force,
            dry_run=args.dry_run,
            project_limit=args.project_limit or None,
            rebuild_body=args.rebuild_body,
        )
        summaries.append(s)
        logger.info(s.as_log_line())

    # 汇总
    logger.info("=" * 60)
    logger.info(f"Processed {len(summaries)} emails")
    for s in summaries:
        logger.info(
            f"  [{s.status}] internal_id={s.internal_id} "
            f"week={s.week_tag} projects={s.projects_total} "
            f"created={s.created} updated={s.updated} "
            f"skipped_idempotent={s.skipped_idempotent} failed={s.failed} "
            f"marked_done={s.marked_done} "
            f"{s.duration_sec:.1f}s"
        )
        for line in s.done_samples:
            logger.info(f"    - done: {line}")
        for line in s.failed_samples:
            logger.warning(f"    - fail: {line}")

    any_failed = any(s.status == "failed" for s in summaries)
    return 1 if any_failed else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--internal-id", type=int, help="指定邮件的 AppleScript internal_id")
    g.add_argument(
        "--latest",
        action="store_true",
        help="处理最近一封未完成的 Evelyn 邮件（默认行为）",
    )
    g.add_argument(
        "--all-history",
        action="store_true",
        help="按日期升序回填历史邮件（配合 --limit）",
    )
    p.add_argument("--limit", type=int, default=10, help="--all-history 时最多处理多少封邮件")
    p.add_argument(
        "--project-limit",
        type=int,
        default=0,
        help="每封邮件最多 upsert 多少个项目（0=全量）。用于小批量验证。",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="不写 Notion，不更新 evelyn_project_sync；只打印统计",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="忽略已 completed 的记录，强制重跑",
    )
    p.add_argument(
        "--rebuild-body",
        action="store_true",
        help="update 路径下把正文完整重写为全量历史 markdown（修年份推断等，"
             "会覆盖用户对正文的手改；property 手改不受影响）",
    )
    p.add_argument(
        "--backfill-project-start",
        action="store_true",
        help=(
            "一次性回填 项目开始时间 字段到所有已入库项目页。"
            "从指定/最新 xlsx 重新算 earliest_progress_date，"
            "只 update 这一个 property，不 touch 正文/其他字段。"
        ),
    )
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    _setup_logger(args.verbose)
    if not getattr(config, "evelyn_sync_enabled", False):
        logger.error(
            "EVELYN_SYNC_ENABLED=false。该外挂模块默认关闭，请在本地 .env 设置 "
            "EVELYN_SYNC_ENABLED=true 后再运行。"
        )
        return 2
    if not getattr(config, "project_progress_database_id", ""):
        logger.error(
            "PROJECT_PROGRESS_DATABASE_ID 未配置。请在 .env 设置 "
            "PROJECT_PROGRESS_DATABASE_ID=<notion 项目进度库 ID>"
        )
        return 2

    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
