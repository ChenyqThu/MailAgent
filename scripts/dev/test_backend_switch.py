#!/usr/bin/env python3
"""Dry-run backend switching: probe + 抽样 fetch 比对 AppleScript ↔ DavMail.

用法:
    source venv/bin/activate
    # 仅 AppleScript probe + 抽样 fetch
    python scripts/dev/test_backend_switch.py --backend applescript --samples 3

    # 仅 DavMail (需 PoC online: pm2 ls | grep davmail-poc)
    python scripts/dev/test_backend_switch.py --backend davmail --samples 3

    # 两 backend 都跑, 同邮件抽样 diff (subject 应一致)
    python scripts/dev/test_backend_switch.py --backend both --samples 3

输出:
    每个 backend 的 probe + detect baseline marker + N 封邮件 fetch latency / subject.

退出码:
    0 全部 OK
    1 probe 失败 或 fetch miss
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from typing import Optional

# 让脚本支持从仓库根目录跑 (不需要 PYTHONPATH=.)
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from src.config import config  # noqa: E402
from src.mail.backend import BackendStartupError, create_backend  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402


def sample_internal_ids(db_path: str, n: int) -> list[tuple[int, str, str]]:
    """从 sync_store 取 N 封最近 synced INBOX 邮件的 (internal_id, message_id, mailbox)."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """SELECT internal_id, message_id, mailbox FROM email_metadata
           WHERE sync_status='synced' AND message_id IS NOT NULL
             AND mailbox='收件箱'
           ORDER BY internal_id DESC LIMIT ?""",
        (n,),
    ).fetchall()
    conn.close()
    return [(int(r[0]), r[1], r[2]) for r in rows]


def run_backend(backend_name: str, samples: list[tuple[int, str, str]]) -> dict:
    """探测 + 抽样 fetch. 返回 {backend, probe_ok, baseline_marker, samples: [{iid, ok, ms, subject}]}."""
    print(f"\n========== backend = {backend_name!r} ==========")
    store = SyncStore(config.sync_store_db_path)
    cfg = type("C", (), {**{k: v for k, v in config.model_dump().items()}, "mailagent_backend": backend_name})()

    try:
        backend = create_backend(cfg, sync_store=store)
    except BackendStartupError as e:
        print(f"  [fail] BackendStartupError: {e}")
        if e.fallback_hint:
            print(f"    → {e.fallback_hint}")
        return {"backend": backend_name, "probe_ok": False, "error": str(e), "samples": []}

    print(f"  probe ok ({backend.backend_origin})")
    tick = backend.detect_new_emails(None)
    print(f"  baseline marker: {tick.current_marker}")

    sample_results = []
    for iid, mid, mbox in samples:
        t0 = time.time()
        ec = backend.fetch_email_by_id(iid, mailbox=mbox)
        ms = int((time.time() - t0) * 1000)
        if ec:
            print(f"  fetch internal_id={iid} ({ms:>5}ms): {ec.subject[:60]!r}")
            sample_results.append({
                "internal_id": iid, "ok": True, "ms": ms,
                "subject": ec.subject, "message_id": ec.message_id,
                "imap_uid": ec.imap_uid,
            })
        else:
            print(f"  fetch internal_id={iid} ({ms:>5}ms): [MISS]")
            sample_results.append({"internal_id": iid, "ok": False, "ms": ms})

    return {
        "backend": backend_name, "probe_ok": True,
        "baseline_marker": tick.current_marker,
        "samples": sample_results,
    }


def diff_samples(a: list[dict], b: list[dict]) -> int:
    """比对两个 backend 的 sample 结果, return mismatch count (subject 不一致)."""
    mismatch = 0
    a_by_iid = {s["internal_id"]: s for s in a if s.get("ok")}
    b_by_iid = {s["internal_id"]: s for s in b if s.get("ok")}
    common = sorted(set(a_by_iid) & set(b_by_iid))
    print(f"\n========== diff ({len(common)} common samples) ==========")
    for iid in common:
        sa, sb = a_by_iid[iid], b_by_iid[iid]
        if sa["subject"] != sb["subject"]:
            mismatch += 1
            print(f"  MISMATCH internal_id={iid}:")
            print(f"    a: {sa['subject'][:80]!r}")
            print(f"    b: {sb['subject'][:80]!r}")
        else:
            print(f"  OK internal_id={iid} subject matches")
    if mismatch == 0 and common:
        print(f"  [ok] {len(common)}/{len(common)} subjects match")
    return mismatch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="both", choices=["applescript", "davmail", "both"])
    parser.add_argument("--samples", type=int, default=3, help="抽样邮件数")
    args = parser.parse_args()

    db_path = config.sync_store_db_path
    samples = sample_internal_ids(db_path, args.samples)
    if not samples:
        print(f"[fail] no synced INBOX emails in {db_path}")
        return 1
    print(f"sampled internal_ids: {[s[0] for s in samples]}")

    if args.backend in ("applescript", "both"):
        res_a = run_backend("applescript", samples)
        if not res_a["probe_ok"]:
            return 1

    if args.backend in ("davmail", "both"):
        res_d = run_backend("davmail", samples)
        if not res_d["probe_ok"]:
            return 1

    if args.backend == "both":
        mismatches = diff_samples(res_a["samples"], res_d["samples"])
        if mismatches > 0:
            print(f"\n[fail] {mismatches} subject mismatch(es)")
            return 1

    print("\n[ok] all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
