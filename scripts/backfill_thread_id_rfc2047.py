#!/usr/bin/env python3
"""一次性回填: 修复被 RFC 2047 编码污染的 thread_id (fix/reply-thread-rfc2047).

背景: 旧版发件把长 Exchange Message-ID 的 In-Reply-To/References 序列化成
encoded-word (``=?utf-8?q?=3C...?=``); davmail 读取时未解码就 split, 把 encoded-word
碎片当 thread_id 存进 ``email_metadata`` → 同一线程被切成两段 (回复处断裂)。

本脚本扫 ``thread_id LIKE '=?%'`` 的行, 用**已修复**的 davmail backend 重取 MIME
(``fetch_email_by_id`` 内部已 RFC 2047 解码) 重算 thread_id, 写回 SQLite。

安全:
- **dry-run 默认** —— 不加 ``--apply`` 只打印 before/after, 全程只读。
- ``--apply`` 在单事务内 UPDATE, ``busy_timeout`` 容忍运行中 app 的并发读写。
- 每次都把 ``{internal_id: {old, new}}`` 落盘到 ``--journal`` (默认脚本同目录),
  作回滚依据 (无需备份 1.9GB 库)。
- 取不到原邮件 (服务端已删 / uid 失效) 的行**跳过**, 不动其 thread_id。
- Notion 侧不在本脚本做 —— 写回 SQLite 后用
  ``mailagent email resync <id>`` (读修正后的 thread_id 重链 Parent Item)。

用法:
    # 1) dry-run (只读, 看 35 行 before/after)
    python scripts/backfill_thread_id_rfc2047.py
    # 2) 执行写回 SQLite
    python scripts/backfill_thread_id_rfc2047.py --apply
    # 3) 只跑指定几封 (验证用)
    python scripts/backfill_thread_id_rfc2047.py --apply --only 1000007032,1000007059

必须用**修复后**的代码跑 (PYTHONPATH 指向含本修复的 src), 否则重算仍是坏值。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from typing import Optional

_DEFAULT_APP_DATA_ROOT = os.path.expanduser(
    "~/Library/Application Support/mailagent-frontend"
)


def _looks_encoded(thread_id: Optional[str]) -> bool:
    """RFC 2047 encoded-word 形式 (我们要修的污染值)。"""
    return bool(thread_id) and thread_id.lstrip().startswith("=?")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--data-root",
        default=os.environ.get("MAILAGENT_DATA_ROOT", _DEFAULT_APP_DATA_ROOT),
        help="MAILAGENT_DATA_ROOT (默认 = 打包 app 的 userData)",
    )
    ap.add_argument(
        "--db",
        default="",
        help="sync_store.db 绝对路径 (缺省 = <data-root>/data/sync_store.db); "
        "显式给避免被 .env SYNC_STORE_DB_PATH 相对路径覆盖",
    )
    ap.add_argument("--apply", action="store_true", help="真正写回 SQLite (否则 dry-run)")
    ap.add_argument(
        "--from-journal",
        action="store_true",
        help="跳过 davmail 重取, 直接用上次 dry-run 写的 journal 值写回 (--apply 时用, 省一遍重取)",
    )
    ap.add_argument(
        "--only", default="", help="只处理这些 internal_id (逗号分隔), 缺省=全部污染行"
    )
    ap.add_argument(
        "--journal",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "backfill_thread_id_rfc2047.journal.json"),
        help="before/after 落盘路径 (回滚依据)",
    )
    args = ap.parse_args()

    # config 在 import 时 eager 实例化, 必须先设 MAILAGENT_DATA_ROOT
    os.environ["MAILAGENT_DATA_ROOT"] = args.data_root
    try:
        from dotenv import load_dotenv

        load_dotenv()  # 加载 .env (davmail 端口 / 账号 / token)
    except Exception:
        pass

    from src.config import config
    from src.mail.backend.factory import create_backend
    from src.mail.sync_store import SyncStore

    # 显式 --db 优先; 否则用 <data-root>/data/sync_store.db (不读 config.sync_store_db_path,
    # 它会被 .env 的相对 SYNC_STORE_DB_PATH 覆盖指错库)。
    db_path = args.db or os.path.join(args.data_root, "data", "sync_store.db")
    print(f"[backfill] DATA_ROOT = {args.data_root}")
    print(f"[backfill] DB        = {db_path}")
    print(f"[backfill] backend   = {getattr(config, 'mailagent_backend', '?')}")
    if getattr(config, "mailagent_backend", "applescript") != "davmail":
        print("[backfill] ✗ 需要 MAILAGENT_BACKEND=davmail 才能重取 MIME, 中止。")
        return 2
    if not os.path.exists(db_path):
        print(f"[backfill] ✗ DB 不存在: {db_path}")
        return 2

    only_ids = {int(x) for x in args.only.split(",") if x.strip()} if args.only else None

    # 1) 选出污染行 (只读 sqlite, 不经 ORM)
    ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    ro.row_factory = sqlite3.Row
    rows = ro.execute(
        "SELECT internal_id, mailbox, message_id, thread_id, imap_uid "
        "FROM email_metadata WHERE thread_id LIKE '=?%' ORDER BY internal_id"
    ).fetchall()
    ro.close()
    targets = [r for r in rows if (only_ids is None or r["internal_id"] in only_ids)]
    print(f"[backfill] 污染行(thread_id LIKE '=?%'): {len(rows)}  本次处理: {len(targets)}\n")
    if not targets:
        print("[backfill] 无目标行, 退出。")
        return 0

    # 2) 构建 plan
    plan: dict[str, dict] = {}
    if args.from_journal:
        # 用上次 dry-run 写的 journal 值, 跳过 davmail 重取 (省一遍 ~6min)。
        if not os.path.exists(args.journal):
            print(f"[backfill] ✗ --from-journal 但 journal 不存在: {args.journal}")
            return 2
        with open(args.journal) as f:
            journal = json.load(f)
        cur = {r["internal_id"]: r["thread_id"] for r in targets}  # 仍污染的当前行
        for iid_str, ch in journal.items():
            iid = int(iid_str)
            if only_ids is not None and iid not in only_ids:
                continue
            # 幂等: 仅写"当前仍是编码值"且"journal 给了干净值"的行
            if iid in cur and _looks_encoded(cur[iid]) and not _looks_encoded(ch.get("new")):
                plan[iid_str] = ch
        print(f"[backfill] from-journal: 待写 {len(plan)} 行 (仍污染 + journal 有干净值)")
    else:
        # davmail 重取重算
        sync_store = SyncStore(db_path)
        backend = create_backend(config, sync_store=sync_store)
        n_fix, n_same, n_miss, n_stillbad = 0, 0, 0, 0
        for r in targets:
            iid = r["internal_id"]
            old = r["thread_id"]
            try:
                ec = backend.fetch_email_by_id(iid, mailbox=r["mailbox"])
            except Exception as e:
                ec = None
                print(f"  [{iid}] ✗ 重取异常: {e}")
            if ec is None:
                n_miss += 1
                print(f"  [{iid}] ⚠ 重取不到 (uid={r['imap_uid']} mailbox={r['mailbox']}), 跳过")
                continue
            new = ec.thread_id
            if new and _looks_encoded(new):
                n_stillbad += 1
                print(f"  [{iid}] ✗ 重算仍是编码值(代码未修复?): {new[:40]!r}, 跳过")
                continue
            if not new or new == old:
                n_same += 1
                print(f"  [{iid}] = 无变化 (new={new!r})")
                continue
            n_fix += 1
            plan[str(iid)] = {"old": old, "new": new, "mailbox": r["mailbox"]}
            print(f"  [{iid}] {r['mailbox']:<6} old={old[:34]!r}…")
            print(f"            new={new!r}")
        print(
            f"\n[backfill] 可修复={n_fix}  无变化={n_same}  重取不到={n_miss}  仍编码={n_stillbad}"
        )

    # 3) 落盘 journal (仅重取模式; from-journal 不覆盖原 journal) + (可选) 写回
    if plan and not args.from_journal:
        with open(args.journal, "w") as f:
            json.dump(plan, f, ensure_ascii=False, indent=2)
        print(f"[backfill] before/after 已写 {args.journal}")

    if not args.apply:
        print("\n[backfill] DRY-RUN —— 未写库。确认无误后加 --apply 执行。")
        return 0

    if not plan:
        print("[backfill] 无可写回项。")
        return 0

    w = sqlite3.connect(db_path, timeout=15)
    w.execute("PRAGMA busy_timeout=15000")
    try:
        with w:  # 单事务
            for iid, ch in plan.items():
                w.execute(
                    "UPDATE email_metadata SET thread_id=?, updated_at=updated_at "
                    "WHERE internal_id=?",
                    (ch["new"], int(iid)),
                )
        print(f"[backfill] ✓ 已写回 {len(plan)} 行 thread_id。")
    finally:
        w.close()

    print("\n[backfill] 下一步: 对这些 id 跑 `mailagent email resync <id>` 修 Notion 线程链。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
