#!/usr/bin/env python3
"""v4 Phase 4: 基于 SQLite SSoT 重传邮件到 Notion（不调 AppleScript）。

适用场景:
    - 历史邮件 Notion 页损坏 / 误删 / 字段缺失 → 从 SQLite 重建
    - 灰度切换前抽样人工 diff（同一封邮件分别用 v2 / from_sqlite 跑一次再对比）
    - 模板 / converter 升级后批量重传

特性:
    - 只读 SQLite + 写 Notion，**不碰 AppleScript**（前提是 email_body 行已存在；
      backfill 已覆盖范围内的邮件都可用，未覆盖范围请先跑 backfill）
    - 幂等：默认遇到已存在 page 跳过（除非 --replace-existing）
    - 优雅退出：SIGINT/SIGTERM 当前邮件做完就停
    - 速率显示：每 N 封打印 rate + ETA
    - 失败熔断：连续 N 次失败自动停（默认 5，可调）

Usage:
    # 单封验证（dry-run 不写 Notion，只打 SQLite 读取结果）
    python scripts/resync_notion.py --internal-id 53675 --dry-run

    # 单封实跑（已存在则跳过）
    python scripts/resync_notion.py --internal-id 53675

    # 单封强制替换（archive 老页 → 新建）
    python scripts/resync_notion.py --internal-id 53675 --replace-existing

    # 区间批量
    python scripts/resync_notion.py --range 53000-53100

    # 多 internal-id
    python scripts/resync_notion.py --internal-ids 53675,53676,53700

监控:
    sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_attachment WHERE notion_file_id IS NOT NULL"

注意:
    - 不需要 pm2 stop mail-sync（不读 AppleScript），但建议在低峰期跑避免 Notion API 限流
    - 与 backfill 互补：backfill 填 SQLite，resync 把 SQLite 写回 Notion
"""

import argparse
import asyncio
import signal
import sqlite3
import sys
import time
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loguru import logger

from src.config import config as cfg
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.repository import EmailRepository


# 优雅退出标志
_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    if not _shutdown:
        print(f"\n[signal] Received {signum}, will stop after current email...", flush=True)
        _shutdown = True
    else:
        print("\n[signal] Second signal, force exit", flush=True)
        sys.exit(130)


def _parse_ids(args: argparse.Namespace) -> List[int]:
    """从 CLI 参数收集要 resync 的 internal_id 列表。"""
    ids: List[int] = []
    if args.internal_id is not None:
        ids.append(int(args.internal_id))
    if args.internal_ids:
        ids.extend(int(x.strip()) for x in args.internal_ids.split(",") if x.strip())
    if args.range:
        try:
            lo_str, hi_str = args.range.split("-", 1)
            lo, hi = int(lo_str), int(hi_str)
            if lo > hi:
                raise ValueError("range lo > hi")
            ids.extend(range(lo, hi + 1))
        except ValueError as e:
            print(f"Invalid --range {args.range!r}: {e}", file=sys.stderr)
            sys.exit(2)
    if not ids:
        print("Must specify --internal-id / --internal-ids / --range", file=sys.stderr)
        sys.exit(2)
    return sorted(set(ids))


def _filter_candidates(
    ids: List[int], db_path: str
) -> List[int]:
    """过滤出 SQLite 已有 body 的 internal_id（其他的 skip 并报告）。"""
    if not ids:
        return []
    conn = sqlite3.connect(db_path)
    try:
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT internal_id FROM email_body WHERE internal_id IN ({placeholders})",
            ids,
        ).fetchall()
        has_body = {r[0] for r in rows}
    finally:
        conn.close()
    missing = sorted(set(ids) - has_body)
    if missing:
        print(
            f"[warn] {len(missing)} internal_id without email_body, skipping: "
            f"{missing[:10]}{'...' if len(missing) > 10 else ''}",
            flush=True,
        )
        print(
            "[hint] run scripts/backfill_email_body.py first to populate body rows",
            flush=True,
        )
    return sorted(has_body)


async def _resync_one(
    notion_sync: NotionSync,
    repo: EmailRepository,
    sync_store: SyncStore,
    internal_id: int,
    *,
    replace_existing: bool,
    dry_run: bool,
) -> Optional[str]:
    """重传一封邮件。返回 page_id；dry-run 时返回 'DRY-RUN'；失败 None。"""
    if dry_run:
        # 干跑：只读 SQLite + 打印将要做什么，不调 Notion
        body = repo.get_body(internal_id)
        meta = sync_store.get(internal_id)
        atts = repo.get_attachments(internal_id)
        if body is None or meta is None:
            print(f"  [{internal_id}] MISSING body or metadata", flush=True)
            return None
        print(
            f"  [{internal_id}] subject={meta.get('subject', '')[:60]!r} "
            f"format={body.body_format} attachments={len(atts)} "
            f"inline={body.has_inline_images} mailbox={meta.get('mailbox')}",
            flush=True,
        )
        return "DRY-RUN"

    try:
        result = await notion_sync.create_email_page_from_sqlite(
            internal_id,
            repo=repo,
            sync_store=sync_store,
            replace_existing=replace_existing,
            # 历史邮件 resync 不重做线程关系（避免动到 Sub-item 已建好的关系）
            # 用户需要重新计算的话另外跑工具
            skip_parent_lookup=True,
        )
        # script 历史契约是返回 Optional[str] page_id; action / archive 信息日志带出。
        logger.info(
            f"[{internal_id}] resync action={result.action} page_id={result.page_id}"
        )
        return result.page_id
    except ValueError as e:
        logger.warning(f"[{internal_id}] skip (SQLite incomplete): {e}")
        return None
    except Exception as e:
        logger.error(f"[{internal_id}] resync failed: {e}")
        return None


async def main():
    parser = argparse.ArgumentParser(
        description="Resync emails from SQLite to Notion (v4 Phase 4)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    g = parser.add_argument_group("target selection")
    g.add_argument("--internal-id", type=int, help="单封 internal_id")
    g.add_argument(
        "--internal-ids", type=str,
        help="逗号分隔的 internal_id 列表，如 53675,53676,53700"
    )
    g.add_argument(
        "--range", type=str, metavar="LO-HI",
        help="internal_id 区间（闭区间），如 53000-53100"
    )

    parser.add_argument(
        "--replace-existing", action="store_true",
        help="若 Notion 已有同 message_id 的页面，archive 老页 → 新建（默认跳过）"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="只读 SQLite 打印 plan，不写 Notion"
    )
    parser.add_argument(
        "--max-failures", type=int, default=5,
        help="连续失败 N 次自动停（默认 5）"
    )
    parser.add_argument(
        "--progress-every", type=int, default=10,
        help="每 N 封打印一次速率（默认 10）"
    )

    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    ids = _parse_ids(args)
    print(f"[plan] {len(ids)} candidates from CLI args", flush=True)

    valid_ids = _filter_candidates(ids, cfg.sync_store_db_path)
    if not valid_ids:
        print("[done] No valid candidates with body in SQLite", flush=True)
        return

    print(
        f"[ready] {len(valid_ids)} emails to resync "
        f"(dry_run={args.dry_run}, replace_existing={args.replace_existing})",
        flush=True,
    )

    repo = EmailRepository(db_path=cfg.sync_store_db_path)
    sync_store = SyncStore(cfg.sync_store_db_path)
    notion_sync = NotionSync(email_repo=repo, sync_store=sync_store)

    t_start = time.time()
    succeeded = 0
    failed = 0
    consecutive_failures = 0

    for idx, internal_id in enumerate(valid_ids, 1):
        if _shutdown:
            print(f"[stop] Graceful shutdown after {idx - 1}/{len(valid_ids)}", flush=True)
            break

        result = await _resync_one(
            notion_sync, repo, sync_store, internal_id,
            replace_existing=args.replace_existing,
            dry_run=args.dry_run,
        )
        if result is None:
            failed += 1
            consecutive_failures += 1
            if consecutive_failures >= args.max_failures:
                print(
                    f"[abort] {consecutive_failures} consecutive failures, "
                    f"stopping after {idx}/{len(valid_ids)}",
                    flush=True,
                )
                break
        else:
            succeeded += 1
            consecutive_failures = 0

        if idx % args.progress_every == 0 or idx == len(valid_ids):
            elapsed = time.time() - t_start
            rate = idx / elapsed if elapsed > 0 else 0.0
            remaining = len(valid_ids) - idx
            eta_sec = remaining / rate if rate > 0 else 0
            print(
                f"[progress] {idx}/{len(valid_ids)} "
                f"(success={succeeded}, failed={failed}) "
                f"rate={rate:.2f}/s eta={eta_sec / 60:.1f} min",
                flush=True,
            )

    elapsed = time.time() - t_start
    print(
        f"\n[summary] total={len(valid_ids)} success={succeeded} "
        f"failed={failed} elapsed={elapsed / 60:.1f} min",
        flush=True,
    )


if __name__ == "__main__":
    import warnings

    warnings.warn(
        "scripts/resync_notion.py is deprecated; use "
        "'mailagent email resync' instead. Will be removed in PR-6.",
        DeprecationWarning,
        stacklevel=2,
    )
    asyncio.run(main())
