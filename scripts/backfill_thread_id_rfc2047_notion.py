#!/usr/bin/env python3
"""回填 Notion 侧线程关系 (fix/reply-thread-rfc2047 第二步)。

前置: 先跑 ``backfill_thread_id_rfc2047.py --apply`` 把 SQLite ``thread_id`` 修正。
本脚本读该步生成的 journal (被修正的 internal_id), 对每封**已同步到 Notion** 的:
  1. 更新 Notion 页 ``Thread ID`` 属性 → 修正后的线程根 (原为 encoded-word 文本)。
  2. 调 ``handle_thread_relations`` —— 按修正后的 SQLite 线程成员重算
     Parent/Sub-item 关系 ("最新邮件为母节点"), 让原本被切断的回复重新挂回线程。

只动这两处, **不重建页 / 不动正文/附件/评论** (区别于 ``resync --replace``)。
``handle_thread_relations`` 读 SQLite ``get_thread_members(thread_id)``, 故必须先跑完
SQLite 回填。被修正行所属线程里**未污染的成员** (如原始邮件) 会被自动纳入重链, 无需
单独处理。

安全: dry-run 默认; ``--apply`` 才写 Notion。需要 .env 里 ``NOTION_TOKEN`` 等。

用法:
    python scripts/backfill_thread_id_rfc2047_notion.py            # dry-run
    python scripts/backfill_thread_id_rfc2047_notion.py --apply
    python scripts/backfill_thread_id_rfc2047_notion.py --apply --only 1000007032,1000007059
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from typing import Optional

_DEFAULT_APP_DATA_ROOT = os.path.expanduser(
    "~/Library/Application Support/mailagent-frontend"
)


def _parse_dt(iso: Optional[str]):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None


async def _run(args, db_path: str, changes: dict) -> int:
    from src.models import Email
    from src.notion.sync import NotionSync
    from src.repository.attachment_store import AttachmentStore
    from src.repository.email_repository import EmailRepository
    from src.mail.sync_store import SyncStore
    from src.config import config

    sync_store = SyncStore(db_path)
    repo = EmailRepository(
        db_path=db_path,
        attachment_store=AttachmentStore(config.attachment_storage_dir),
    )
    notion_sync = NotionSync(email_repo=repo, sync_store=sync_store)
    notion_client = notion_sync.client.client  # AsyncClient

    n_ok, n_skip, n_err = 0, 0, 0
    for iid_str, ch in changes.items():
        iid = int(iid_str)
        new_tid = ch["new"]
        meta = sync_store.get(iid) or {}
        page_id = meta.get("notion_page_id")
        if not page_id:
            n_skip += 1
            print(f"  [{iid}] ⚠ 无 notion_page_id (未同步 Notion), 跳过")
            continue

        email = Email(
            message_id=meta.get("message_id") or "",
            subject=meta.get("subject") or "(No Subject)",
            sender=meta.get("sender") or "",
            to=meta.get("to_addr") or "",
            cc=meta.get("cc_addr") or "",
            date=_parse_dt(meta.get("date_received")),
            content="",
            thread_id=new_tid,
            mailbox=meta.get("mailbox") or "收件箱",
            internal_id=iid,
        )
        print(f"  [{iid}] {email.mailbox:<6} page={page_id[:8]}… Thread ID→{new_tid[:32]}… + 重链")
        if not args.apply:
            continue
        try:
            # 1) 修 Thread ID 属性文本 (原为 encoded-word)
            await notion_client.pages.update(
                page_id=page_id,
                properties={
                    "Thread ID": {"rich_text": [{"text": {"content": new_tid[:1999]}}]}
                },
            )
            # 2) 按修正后 SQLite 线程成员重链 Parent/Sub-item
            await notion_sync._handle_thread_relations(page_id, email)
            n_ok += 1
        except Exception as e:
            n_err += 1
            print(f"        ✗ Notion 更新失败: {e}")

    if args.apply:
        print(f"\n[notion] ✓ 成功={n_ok}  跳过(无页)={n_skip}  失败={n_err}")
    else:
        print(f"\n[notion] DRY-RUN —— 未写 Notion。待处理={len(changes)} 跳过(无页)={n_skip}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-root", default=os.environ.get("MAILAGENT_DATA_ROOT", _DEFAULT_APP_DATA_ROOT))
    ap.add_argument("--db", default="")
    ap.add_argument("--apply", action="store_true", help="真正写 Notion (否则 dry-run)")
    ap.add_argument("--only", default="", help="只处理这些 internal_id (逗号分隔)")
    ap.add_argument(
        "--journal",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "backfill_thread_id_rfc2047.journal.json"),
    )
    args = ap.parse_args()

    os.environ["MAILAGENT_DATA_ROOT"] = args.data_root
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except Exception:
        pass

    if not os.path.exists(args.journal):
        print(f"[notion] ✗ 找不到 journal: {args.journal} —— 先跑 SQLite 回填。")
        return 2
    with open(args.journal) as f:
        changes = json.load(f)
    only_ids = {x.strip() for x in args.only.split(",") if x.strip()} if args.only else None
    if only_ids:
        changes = {k: v for k, v in changes.items() if k in only_ids}

    db_path = args.db or os.path.join(args.data_root, "data", "sync_store.db")
    if not os.path.exists(db_path):
        print(f"[notion] ✗ DB 不存在: {db_path}")
        return 2
    print(f"[notion] DB={db_path}  待处理={len(changes)} 行\n")
    if not changes:
        print("[notion] journal 空, 退出。")
        return 0
    return asyncio.run(_run(args, db_path, changes))


if __name__ == "__main__":
    sys.exit(main())
