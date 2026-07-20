#!/usr/bin/env python3
"""一次性回填: 归一化被 RFC 2047 编码 / 折行污染的 message_id（issue #47）。

背景: davmail backend 的三个 MIME parse 点此前把 ``Message-ID`` 头原始值直接落库
（同文件里 Subject/From/References 早就过 ``_decode_mime_header``，唯独 Message-ID
漏了）。发件方（Bugzilla / 旧版 Outlook 中继）会把长 Message-ID 编成 encoded-word
并折行，于是库里存进 ``=?UTF-8?Q?=3C...?=\\r\\n =?UTF-8?Q?/=3E?=`` 这种值。

**为什么读取侧的兼容救不了存量**:
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

安全（codex review 两轮的结论都落在这里，动生产库前请读完）:

- **dry-run 默认** —— 不加 ``--apply`` 对**数据库**全程只读（``mode=ro`` 打开）。
  注意它仍会写 plan journal 文件，"只读" 指的是库。
- **apply 走单连接 + BEGIN IMMEDIATE**: 扫描、冲突预检、UPDATE 在**同一个事务**里
  完成。首版是"只读连接扫完关掉 → 隔一会儿开写连接按 internal_id 无条件 UPDATE"，
  中间窗口里 app 若改了同一行，脚本会拿旧 plan 覆盖新值（``busy_timeout`` 只解决
  "锁等多久"，完全不解决 stale snapshot）。
- **CAS 更新**: ``WHERE internal_id=? AND message_id IS ?``，``rowcount != 1`` 立即
  抛错回滚整个事务。宁可整批不写，也不要写错一行。
- **UNIQUE 冲突按归一化后的目标值分组预检**。首版按归一化**前**的原始值建索引，
  只能发现"脏行撞已有干净值"，漏掉"两个不同的脏值归一到同一目标"（实测
  ``(relay) <a@x.com>`` 和 ``<a@x.com> (mx)`` 都归一成 ``a@x.com``）。现在任何目标
  组含多于一个 internal_id，整组跳过。
- **非空旧值绝不写成空**。``<>`` 会归一成 ``''`` —— 写回等于抹掉原始标识，多行还会
  在空串上撞 UNIQUE。这类行报告并跳过。
- **plan journal 与 applied journal 分开**。前者是"打算改什么"（dry-run 就写），后者
  只在 commit 成功后写，带 DB 路径 + 时间 + 实际生效行数。**只有 applied journal
  才是回滚依据** —— 拿一份没提交的 plan 去回滚，会覆盖掉后来的合法修改。
- 冲突不自动处置。判定谁是真身要看 sync_status，删行不可逆 —— 对齐
  ``update_after_fetch`` 的铁律（宁可留一行垃圾，不能吞一封真邮件），只报告。

**为什么不做成 DB_VERSION 迁移**（2026-07-20 owner 拍板，别再重提）:
codex review 主张这该进 ``DB_VERSION`` 阶梯（v38 幂等迁移），理由是现有用户升级后
不会自己跑脚本。不采纳，理由是风险收益不对等:

- 脏值**只在 davmail 写入侧未归一化那段时间**产生。修复合入后新写入恒干净，
  存量是一个**不再增长**的有限集合；
- owner 库实测 9311 行 **0 脏 message_id**。为一个可能是空集的清洗，在**每次启动**
  的关键路径上加一道全表扫描 + 带冲突判定的写事务（大邮箱 6-7 万行），风险明显更大;
- 迁移在启动时无人值守，遇到 UNIQUE 冲突只能自己拍板；而这里的冲突恰恰是
  "两行谁是真身" 这种**必须看 sync_status 人工判定**的问题（见 update_after_fetch
  的铁律）。人工脚本能把冲突打出来让人看，迁移不能。

用法::

    # 1) dry-run：看有多少脏行、会改成什么、有没有冲突
    python scripts/backfill_message_id_normalize.py
    # 2) 写回（建议先退出 app，虽然 CAS + 单事务已经能挡住并发写）
    python scripts/backfill_message_id_normalize.py --apply

必须用**修复后**的代码跑（``_normalize_message_id`` 要存在），否则算不出干净值。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

_DEFAULT_APP_DATA_ROOT = os.path.expanduser("~/Library/Application Support/mailagent-frontend")


class BackfillAborted(RuntimeError):
    """CAS 失配 —— 库在扫描后被改动。抛出以回滚整个事务。"""


def _looks_dirty_thread_id(value: str) -> bool:
    """thread_id 是否带 encoded-word / 折行残留（只用于统计报告，不驱动写入）。"""
    return "=?" in value or "\r" in value or "\n" in value


def _plan_from(conn: sqlite3.Connection, normalize) -> tuple[dict, list, list, list, int, int]:
    """扫描 + 冲突预检。返回 (plan, conflicts, blanked, dirty_tids, n_rows, n_clean)。

    🔴 冲突预检按**归一化后的目标值**分组: 干净行的目标 = 它自己的现值, 脏行的目标 =
    归一化结果。任何目标下挂着多于一个 internal_id, 整组都跳过 —— 这同时覆盖
    "脏行撞已有干净行" 和 "两个脏行互撞" 两种情况(后者按原始值建索引是查不出来的)。
    """
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT internal_id, mailbox, sync_status, message_id, thread_id "
        "FROM email_metadata ORDER BY internal_id"
    ).fetchall()

    dirty_tids = [r["internal_id"] for r in rows if r["thread_id"] and _looks_dirty_thread_id(r["thread_id"])]

    targets: dict[int, str] = {}  # internal_id → 归一化后的目标值
    changing: dict[int, sqlite3.Row] = {}  # 需要改写的行
    blanked: list[tuple[int, str, str]] = []  # 非空旧值 → 空目标, 必须跳过
    n_clean = 0

    for r in rows:
        iid = r["internal_id"]
        old = r["message_id"]
        if not old:
            continue  # NULL/空 message_id 不参与（它本来就不进 UNIQUE 索引的等值比较）
        new = normalize(old)
        if new == old:
            n_clean += 1
            targets[iid] = old
            continue
        if not new or not new.strip():
            # `<>` 之类会归一成空串 —— 写回等于抹掉原始标识, 多行还会在空串上撞 UNIQUE。
            blanked.append((iid, r["sync_status"], old))
            targets[iid] = old  # 保持原值参与占位, 不释放给别人
            continue
        targets[iid] = new
        changing[iid] = r

    # 按目标值分组
    owners: dict[str, list[int]] = {}
    for iid, tgt in targets.items():
        owners.setdefault(tgt, []).append(iid)

    plan: dict[str, dict] = {}
    conflicts: list[tuple[int, str, str, list[int]]] = []
    for iid, r in changing.items():
        tgt = targets[iid]
        group = owners.get(tgt, [])
        if len(group) > 1:
            conflicts.append((iid, r["sync_status"], tgt, [x for x in group if x != iid]))
            continue
        plan[str(iid)] = {
            "mailbox": r["mailbox"],
            "sync_status": r["sync_status"],
            "old_message_id": r["message_id"],
            "new_message_id": tgt,
        }

    return plan, conflicts, blanked, dirty_tids, len(rows), n_clean


def _report(plan, conflicts, blanked, dirty_tids, n_rows, n_clean) -> None:
    print(
        f"[backfill] 扫描 {n_rows} 行: message_id 干净 {n_clean} · 待归一化 {len(plan)} · "
        f"目标冲突 {len(conflicts)} · 归一化成空(跳过) {len(blanked)}\n"
    )
    for iid, ch in list(plan.items())[:40]:
        print(
            f"  [{iid}] {ch['sync_status']:<12} {str(ch['old_message_id'])[:44]!r}…"
            f"\n              → {ch['new_message_id']!r}"
        )
    if len(plan) > 40:
        print(f"  … 另有 {len(plan) - 40} 行未打印（全量见 plan journal）")

    if blanked:
        print("\n[backfill] ⚠ 归一化后为空的行（**已跳过**，写回等于抹掉原始标识）:")
        for iid, st, old in blanked:
            print(f"  [{iid}] {st} old={old!r}")

    if conflicts:
        print("\n[backfill] ⚠ 归一化后目标值冲突的行（**已跳过**，需人工判定谁是真身）:")
        for iid, st, tgt, others in conflicts:
            print(f"  [{iid}] {st} 目标 {tgt!r} 与 {others} 相同")
        print(
            "  处置参考 sync_store.update_after_fetch 的铁律: 只有真身**存在且已 synced**\n"
            "  才能认定另一行是重复行；真身未 synced = 谁都不动，留人工。"
        )

    if dirty_tids:
        print(
            f"\n[backfill] ℹ 另有 {len(dirty_tids)} 行 thread_id 带 encoded-word/折行残留，"
            "\n           **本脚本不动它们** —— thread_id 去括号存且可能含多个 msgid，"
            "\n           正确算法要重取 MIME 走 _thread_id_from_headers。用："
            "\n             python scripts/backfill_thread_id_rfc2047.py"
        )


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
        help="journal 路径前缀; 实际写 <path> (plan) 和 <path>.applied.json (已生效)",
    )
    args = ap.parse_args()

    # 只用归一化纯函数，不碰 config / backend —— 本脚本不需要 davmail 在跑。
    from src.mail.backend.davmail_backend import _normalize_message_id

    db_path = args.db or os.path.join(args.data_root, "data", "sync_store.db")
    print(f"[backfill] DB = {db_path}")
    if not os.path.exists(db_path):
        print(f"[backfill] ✗ DB 不存在: {db_path}")
        return 2

    if not args.apply:
        ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            result = _plan_from(ro, _normalize_message_id)
        finally:
            ro.close()
        plan = result[0]
        _report(*result)
        if plan:
            with open(args.journal, "w") as f:
                json.dump(plan, f, ensure_ascii=False, indent=2)
            print(f"\n[backfill] plan 已写 {args.journal}（这是**计划**，不是回滚依据）")
        print("\n[backfill] DRY-RUN —— 未写库。确认无误后加 --apply 执行。")
        return 0

    # ---- apply: 扫描 + 预检 + 写回全在同一事务内 ----
    # 首版是"只读连接扫完关掉 → 另开写连接按 internal_id 无条件 UPDATE"，中间窗口
    # app 若改了同一行会被旧 plan 覆盖。BEGIN IMMEDIATE 从扫描起就拿写锁，CAS 再兜
    # 一层：任何一行的现值与扫描时不符即中止回滚。
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=30000")
    applied = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        result = _plan_from(conn, _normalize_message_id)
        plan = result[0]
        _report(*result)
        if not plan:
            conn.execute("ROLLBACK")
            print("\n[backfill] 无可写回项。")
            return 0
        with open(args.journal, "w") as f:
            json.dump(plan, f, ensure_ascii=False, indent=2)
        for iid, ch in plan.items():
            cur = conn.execute(
                "UPDATE email_metadata SET message_id=? "
                "WHERE internal_id=? AND message_id IS ?",
                (ch["new_message_id"], int(iid), ch["old_message_id"]),
            )
            if cur.rowcount != 1:
                raise BackfillAborted(
                    f"internal_id={iid} 的 message_id 在扫描后被改动或行已消失 "
                    f"(rowcount={cur.rowcount}) —— 整批回滚，请退出 app 后重跑"
                )
            applied += 1
        conn.execute("COMMIT")
    except BackfillAborted as e:
        conn.execute("ROLLBACK")
        print(f"\n[backfill] ✗ {e}")
        return 3
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

    applied_path = args.journal + ".applied.json"
    with open(applied_path, "w") as f:
        json.dump(
            {
                "db_path": os.path.abspath(db_path),
                "applied_at": datetime.now(timezone.utc).isoformat(),
                "rows": plan,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n[backfill] ✓ 已写回 {applied} 行。")
    print(f"[backfill] 回滚依据（**只有这份**代表已生效的变更）: {applied_path}")
    print(
        "[backfill] 后续: 线程关联在 Notion 侧不会自动重链，受影响的线程用\n"
        "           mailagent email resync <internal_id> 重推。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
