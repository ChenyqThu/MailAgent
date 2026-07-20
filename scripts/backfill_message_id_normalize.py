#!/usr/bin/env python3
"""一次性回填: 归一化被 RFC 2047 编码 / 折行污染的 message_id + thread_id（issue #47）。

背景: davmail backend 的三个 MIME parse 点此前把 ``Message-ID`` 头原始值直接落库
（同文件里 Subject/From/References 早就过 ``_decode_mime_header``，唯独 Message-ID
漏了）。发件方（Bugzilla / 旧版 Outlook 中继）会把长 Message-ID 编成 encoded-word
并折行，于是库里存进 ``=?UTF-8?Q?=3C...?=\\r\\n =?UTF-8?Q?/=3E?=`` 这种值。

**为什么读取侧的兼容救不了存量**（codex review HIGH-1）:
``_lookup_uid_by_message_id`` 现在会先归一化，所以**会重新 fetch 的行**自愈；但已经
``synced`` 的行不再进 fetch 路径，脏值就一直留着。后果:

- ``get_by_message_id`` / cross-backend merge 是纯 SQLite 等值比较 —— 干净值查不到
  脏行，同一封信会被当成新邮件写出**第二行**；
- 线程根的 ``thread_id`` 兜底自 message_id，脏根 ≠ 子邮件从 References 解码出的干净
  值（References 早就解码了），**线程从中间断开**。

本脚本是纯函数重写: 读出 ``message_id``，过 ``_normalize_message_id``，不同就写回。
不重取 MIME、不联网、不需要 davmail 在跑。

🔴 **为什么不动 thread_id**（首版写了，跑真库当场被打脸，删掉）:
``thread_id`` 是**去尖括号存**的，而且可能装着 References 来的**多个** msgid。拿
msgid 归一化函数去 unfold 它，会把 ``a@x.com>\\n <b@x.com`` 粘成 ``a@x.com><b@x.com``
—— 造出一个比原值更糟的新错值。这个字段的正确算法是 ``_thread_id_from_headers``
（split References 取 ``parts[0]``），需要原始头，因此归 ``backfill_thread_id_rfc2047.py``
（它重取 MIME 重算）。本脚本只**统计并报告**脏 thread_id 行数，指向那个脚本。

🔴 UNIQUE 冲突不自动处置。``email_metadata.message_id`` 是 ``TEXT UNIQUE`` 列约束。
归一化后撞上既有行 = 「这封邮件已经有一行干净的了，当前行是 bug 制造出来的重复行」。
但**判定谁是真身要看 sync_status，删行是不可逆操作** —— 对齐 ``update_after_fetch``
的铁律（宁可留一行垃圾，不能吞一封真邮件），这里只**报告**冲突对并跳过，交人工处置。

安全:
- **dry-run 默认** —— 不加 ``--apply`` 全程只读（``mode=ro`` 打开）。
- ``--apply`` 单事务写回，``busy_timeout`` 容忍运行中 app 的并发读写。
- before/after 落盘 ``--journal``，作回滚依据。
- 干净行零改动（归一化在干净值上是 no-op）。

用法::

    # 1) dry-run：看有多少脏行、会改成什么、有没有 UNIQUE 冲突
    python scripts/backfill_message_id_normalize.py
    # 2) 写回
    python scripts/backfill_message_id_normalize.py --apply
    # 3) 指定库
    python scripts/backfill_message_id_normalize.py --db /path/to/sync_store.db --apply

必须用**修复后**的代码跑（``_normalize_message_id`` 要存在），否则算不出干净值。

相关: ``scripts/backfill_thread_id_rfc2047.py`` 处理的是**需要重取 MIME** 才能重算的
encoded thread_id（fix/reply-thread-rfc2047）；本脚本只做纯函数归一化，两者互补。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

_DEFAULT_APP_DATA_ROOT = os.path.expanduser("~/Library/Application Support/mailagent-frontend")


def _looks_dirty_thread_id(value: str) -> bool:
    """thread_id 是否带 encoded-word / 折行残留（只用于统计报告，不驱动写入）。"""
    return "=?" in value or "\r" in value or "\n" in value


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
        "--journal",
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "backfill_message_id_normalize.journal.json",
        ),
        help="before/after 落盘路径 (回滚依据)",
    )
    args = ap.parse_args()

    # 只用归一化纯函数，不碰 config / backend —— 本脚本不需要 davmail 在跑。
    from src.mail.backend.davmail_backend import _normalize_message_id

    db_path = args.db or os.path.join(args.data_root, "data", "sync_store.db")
    print(f"[backfill] DB = {db_path}")
    if not os.path.exists(db_path):
        print(f"[backfill] ✗ DB 不存在: {db_path}")
        return 2

    ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    ro.row_factory = sqlite3.Row
    rows = ro.execute(
        "SELECT internal_id, mailbox, sync_status, message_id, thread_id "
        "FROM email_metadata ORDER BY internal_id"
    ).fetchall()

    # 归一化后的目标值 → 已经占着这个 message_id 的行（用于 UNIQUE 冲突预检）。
    by_msgid: dict[str, sqlite3.Row] = {}
    for r in rows:
        if r["message_id"]:
            by_msgid[r["message_id"]] = r

    plan: dict[str, dict] = {}
    conflicts: list[tuple[int, str, int, str]] = []
    dirty_thread_ids: list[int] = []
    n_clean = 0

    for r in rows:
        iid = r["internal_id"]
        old_mid = r["message_id"]
        old_tid = r["thread_id"]
        new_mid = _normalize_message_id(old_mid) if old_mid else old_mid
        # 归一化在干净值上是 no-op，所以「变了」就等于「原来是脏的」。
        mid_dirty = bool(old_mid) and new_mid != old_mid
        # thread_id 只**统计**不改写 —— 见文件头「为什么不动 thread_id」。
        if old_tid and _looks_dirty_thread_id(old_tid):
            dirty_thread_ids.append(iid)
        if not mid_dirty:
            n_clean += 1
            continue

        if new_mid:
            holder = by_msgid.get(new_mid)
            if holder is not None and holder["internal_id"] != iid:
                # 干净值已被别的行占着 —— 大概率就是这个 bug 制造出的重复行对。
                # 谁是真身要看 sync_status，删行不可逆 → 只报告，不处置。
                conflicts.append((iid, r["sync_status"], holder["internal_id"], holder["sync_status"]))
                continue

        plan[str(iid)] = {
            "mailbox": r["mailbox"],
            "sync_status": r["sync_status"],
            "old_message_id": old_mid,
            "new_message_id": new_mid,
        }

    ro.close()

    print(
        f"[backfill] 扫描 {len(rows)} 行: message_id 干净 {n_clean} · "
        f"待归一化 {len(plan)} · UNIQUE 冲突 {len(conflicts)}\n"
    )

    for iid, ch in list(plan.items())[:40]:
        print(
            f"  [{iid}] {ch['sync_status']:<12} {str(ch['old_message_id'])[:44]!r}…"
            f"\n              → {ch['new_message_id']!r}"
        )
    if len(plan) > 40:
        print(f"  … 另有 {len(plan) - 40} 行未打印（全量见 journal）")

    if dirty_thread_ids:
        print(
            f"\n[backfill] ℹ 另有 {len(dirty_thread_ids)} 行 thread_id 带 encoded-word/折行残留，"
            "\n           **本脚本不动它们** —— thread_id 去括号存且可能含多个 msgid，"
            "\n           正确算法要重取 MIME 走 _thread_id_from_headers。用："
            "\n             python scripts/backfill_thread_id_rfc2047.py"
        )

    if conflicts:
        print("\n[backfill] ⚠ 归一化后会撞 UNIQUE 的行（**已跳过**，需人工判定谁是真身）:")
        for iid, st, other, other_st in conflicts:
            print(f"  [{iid}] {st} 的干净 message_id 已被 [{other}] {other_st} 占用")
        print(
            "  处置参考 sync_store.update_after_fetch 的铁律: 只有真身**存在且已 synced**\n"
            "  才能认定当前行是重复行；真身未 synced = 谁都不动，留人工。"
        )

    if plan:
        with open(args.journal, "w") as f:
            json.dump(plan, f, ensure_ascii=False, indent=2)
        print(f"\n[backfill] before/after 已写 {args.journal}")

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
                # updated_at=updated_at: 不因清洗改动「最后更新时间」语义。
                w.execute(
                    "UPDATE email_metadata SET message_id=?, updated_at=updated_at "
                    "WHERE internal_id=?",
                    (ch["new_message_id"], int(iid)),
                )
        print(f"[backfill] ✓ 已写回 {len(plan)} 行。")
    finally:
        w.close()

    print(
        "\n[backfill] 后续: 线程关联在 Notion 侧不会自动重链，受影响的线程用\n"
        "           mailagent email resync <internal_id> 重推。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
