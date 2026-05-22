#!/usr/bin/env python3
"""一次性 diagnostic — davmail IMAP 服务端 vs 本地 SQLite 对账.

用途: cutover 后验证 SQLite SSoT 数据是否齐全, 没遗漏 mail.app 时代没抓到的邮件.

跨 mailbox: INBOX (收件箱) + Sent Items (发件箱).
窗口: 默认最近 48h.

报告:
  - davmail 端 X 封 (按 message_id 去重)
  - SQLite 端 Y 封 (同窗口, message_id IS NOT NULL)
  - 交集 / 仅 davmail / 仅 SQLite 三组数

用法:
  source venv/bin/activate
  DAVMAIL_POC_MODE=1 python scripts/dev/audit_davmail_vs_sqlite.py --hours 48
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from pathlib import Path

# 加入 repo root 到 sys.path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.config import config as cfg  # noqa: E402
from src.mail.backend.imap_client import imap_session  # noqa: E402


def _imap_fetch_msgids_since(imap, mailbox: str, since_dt: datetime) -> dict:
    """返回 {message_id_clean: {uid, subject, date}}.

    IMAP SEARCH SINCE 用 dd-MMM-YYYY (UTC date) 粒度, 上行后客户端二次过滤精确到秒.
    """
    typ, _ = imap.select(mailbox, readonly=True)
    if typ != "OK":
        print(f"  ⚠ SELECT {mailbox!r} failed", file=sys.stderr)
        return {}
    # SEARCH SINCE: dd-MMM-YYYY format (server 按 IMAP INTERNALDATE 过滤)
    cutoff_str = since_dt.strftime("%d-%b-%Y")
    typ, data = imap.uid("search", None, "SINCE", cutoff_str)
    if typ != "OK" or not data or not data[0]:
        print(f"  {mailbox}: 0 UIDs since {cutoff_str}")
        return {}
    uids = data[0].split()
    if not uids:
        return {}
    print(f"  {mailbox}: {len(uids)} UIDs since {cutoff_str} (server-side filter)")

    # 分批 fetch headers (大批量怕 socket buffer 撑爆)
    out: dict[str, dict] = {}
    BATCH = 200
    for i in range(0, len(uids), BATCH):
        chunk = uids[i:i + BATCH]
        uid_seq = b",".join(chunk).decode()
        typ, data = imap.uid(
            "fetch", uid_seq,
            "(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT DATE)])",
        )
        if typ != "OK" or not data:
            continue
        for item in data:
            if not (isinstance(item, tuple) and len(item) >= 2):
                continue
            meta_bytes = item[0] if isinstance(item[0], (bytes, bytearray)) else b""
            meta = meta_bytes.decode("utf-8", errors="replace")
            # 取 UID
            uid_val = None
            if "UID" in meta:
                tokens = meta.replace("(", " ").replace(")", " ").split()
                for j, t in enumerate(tokens):
                    if t.upper() == "UID" and j + 1 < len(tokens):
                        try:
                            uid_val = int(tokens[j + 1])
                            break
                        except ValueError:
                            pass
            # 解 MIME header
            body = item[1]
            if isinstance(body, str):
                body = body.encode("utf-8", errors="replace")
            try:
                msg = BytesParser().parsebytes(bytes(body))
            except Exception:
                continue
            mid = (msg.get("Message-ID") or "").strip().strip("<>")
            if not mid:
                continue
            from src.mail.backend.davmail_backend import _decode_mime_header
            subj = _decode_mime_header(msg.get("Subject") or "")
            date = (msg.get("Date") or "").strip()
            out[mid] = {"uid": uid_val, "subject": subj, "date": date, "mailbox": mailbox}
    return out


def _sqlite_lookup_msgids(db_path: str, msg_ids: set) -> dict:
    """从 SQLite 反向 lookup 一批 message_id, 返回 {msgid: row} 命中的子集.

    避开双向时间窗口对齐难题 (mail.app date_received 是本地 naive, IMAP SINCE 是 server
    UTC date 粒度, 完全对齐很麻烦). 直接拿 IMAP 端拿到的 message_id 集合反查 SQLite,
    命中即匹配, 不命中即真漏抓.
    """
    if not msg_ids:
        return {}
    out: dict[str, dict] = {}
    msg_ids_list = list(msg_ids)
    # 分批查避免 SQLite parameters limit (默认 999)
    BATCH = 500
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        for i in range(0, len(msg_ids_list), BATCH):
            chunk = msg_ids_list[i:i + BATCH]
            placeholders = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"""SELECT internal_id, message_id, subject, sender, mailbox,
                           sync_status, date_received, created_at, notion_page_id,
                           backend_origin
                      FROM email_metadata
                     WHERE message_id IN ({placeholders})""",
                tuple(chunk),
            ).fetchall()
            for r in rows:
                mid = (r["message_id"] or "").strip().strip("<>")
                out[mid] = dict(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=48, help="对账窗口小时 (default 48)")
    ap.add_argument("--db", default="data/sync_store.db")
    ap.add_argument("--show-sample", type=int, default=10, help="每组 diff 展示样本数")
    args = ap.parse_args()

    # SQLite ``date_received`` 是本地时间 naive 字符串 (mail.app applescript 的口径),
    # IMAP ``SEARCH SINCE`` 是 server UTC date. 都用 local naive 窗口对齐 — 略有差异
    # (IMAP SINCE 是日期粒度) 不影响整体对账判断.
    since_dt = datetime.now() - timedelta(hours=args.hours)
    print(f"=== davmail vs sqlite audit ===")
    print(f"window: last {args.hours}h (since {since_dt.isoformat()} local)")
    print(f"db: {args.db}\n")

    # davmail 端 (INBOX + Sent Items)
    print("[1/2] davmail IMAP fetching ...")
    davmail_data: dict[str, dict] = {}
    with imap_session(cfg, timeout=120) as imap:
        for mbox in ("INBOX", "Sent Items"):
            d = _imap_fetch_msgids_since(imap, mbox, since_dt)
            davmail_data.update(d)
    print(f"davmail total unique message_ids: {len(davmail_data)}")

    # SQLite 端: 反向 lookup, 不再用时间窗口卡 SQLite
    print("\n[2/2] SQLite reverse-lookup ...")
    davmail_ids = set(davmail_data.keys())
    sqlite_data = _sqlite_lookup_msgids(args.db, davmail_ids)
    print(f"sqlite hits (out of {len(davmail_ids)} davmail msgids): {len(sqlite_data)}")

    # Compare: davmail 集合作为基准, 看 SQLite 有没有 hit
    sqlite_ids = set(sqlite_data.keys())
    both = davmail_ids & sqlite_ids
    only_davmail = davmail_ids - sqlite_ids
    # only_sqlite 不再统计 — 反向 lookup 不查 SQLite-only
    only_sqlite = set()

    print(f"\n=== Diff ===")
    print(f"  both (intersection):  {len(both)}")
    print(f"  ONLY davmail (potential miss → SQLite 漏抓!): {len(only_davmail)}")

    if only_davmail:
        print(f"\n⚠ 漏抓样本 (前 {min(args.show_sample, len(only_davmail))}):")
        for mid in list(only_davmail)[:args.show_sample]:
            d = davmail_data[mid]
            print(f"  - mailbox={d['mailbox']} uid={d['uid']} "
                  f"date={d['date'][:25]!r} subject={d['subject'][:50]!r}")
            print(f"    message_id={mid[:70]}")

    if only_sqlite and len(only_sqlite) <= 20:
        print(f"\n? sqlite-only 样本 (前 {min(args.show_sample, len(only_sqlite))}):")
        for mid in list(only_sqlite)[:args.show_sample]:
            d = sqlite_data[mid]
            print(f"  - iid={d['internal_id']} sync_status={d['sync_status']} "
                  f"mailbox={d['mailbox']} backend={d['backend_origin']}")
            print(f"    subject={d['subject'][:50]!r} date_received={d['date_received'][:25]!r}")
    elif only_sqlite:
        print(f"\n(sqlite-only 较多, 不展示样本; 通常是窗口边界邮件)")

    print(f"\nresult: {'⚠ MISS' if only_davmail else '✓ OK'} "
          f"(davmail={len(davmail_ids)}, sqlite={len(sqlite_ids)}, intersect={len(both)})")
    sys.exit(0 if not only_davmail else 1)


if __name__ == "__main__":
    main()
