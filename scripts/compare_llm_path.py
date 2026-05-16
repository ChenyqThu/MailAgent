"""Phase 2 P2-03: 对比 LLM 在 SQLite markdown 路径 vs in-memory 正则 fallback 下的分类输出.

目的:
    切换 LLM 输入从"正则剥 HTML"到"markdownify 产物"后，验证关键 AI 标签
    （category / action_type / priority / sender_priority / language /
     action_required / daily_digest_date）的稳定性。
    门槛: 80%+ 一致 → 通过。

实现:
    对每封邮件:
        1. AppleScript 取 MIME source
        2. parse_email_source 出 Email 对象（同一个对象给 A/B 用）
        3. Path A: LLMProcessor(repo=None) → fallback 正则剥 HTML
        4. Path B: LLMProcessor(repo=MockRepo(internal_id, markdown))
           → SQLite hit 直接吃 markdownify 产物
        5. 对比 AILabels 关键字段
    cache 在 system prefix 上稳定命中，path A 第一次写 cache 后 path B 起全 hit.

usage:
    python scripts/compare_llm_path.py --count 10
    python scripts/compare_llm_path.py --internal-ids 53675,53674,53672
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# 让脚本能从 repo 根目录跑
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import config as cfg
from src.llm_agent.processor import LLMProcessor
from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.repository import AttachmentStore, EmailRepository
from src.repository.storage_payload_builder import build_storage_payloads


_KEYS = [
    "category",
    "action_type",
    "priority",
    "action_required",
    "sender_priority",
    "language",
    "daily_digest_date",
]


def _pick_internal_ids(count: int, db_path: str) -> List[int]:
    """选最近 synced 的 N 封邮件."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """SELECT internal_id FROM email_metadata
               WHERE sync_status='synced' AND notion_page_id IS NOT NULL
               ORDER BY updated_at DESC LIMIT ?""",
            (count,),
        ).fetchall()
    finally:
        conn.close()
    return [r[0] for r in rows]


def _lookup_metadata(internal_id: int, db_path: str) -> Optional[Dict[str, Any]]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM email_metadata WHERE internal_id = ?", (internal_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


class _MockRepo:
    """单封邮件 in-memory repo：让 path B 强制走 SQLite-hit 分支."""

    def __init__(self, internal_id: int, markdown: str):
        self._iid = internal_id
        self._md = markdown

    def get_body_markdown(self, internal_id, max_chars=-1):
        if internal_id != self._iid or not self._md:
            return None
        if max_chars > 0 and len(self._md) > max_chars:
            return self._md[:max_chars]
        return self._md


async def _compare_one(
    internal_id: int,
    arm: AppleScriptArm,
    reader: EmailReader,
    store: EmailRepository,
) -> Dict[str, Any]:
    """对单封邮件跑 path A + path B，返回 diff."""
    meta = _lookup_metadata(internal_id, cfg.sync_store_db_path)
    if not meta:
        return {"internal_id": internal_id, "ok": False, "error": "metadata not found"}

    mailbox = meta.get("mailbox") or "收件箱"

    # 1. AppleScript 取 source
    full = arm.fetch_email_content_by_id(internal_id, mailbox)
    if not full:
        return {"internal_id": internal_id, "ok": False, "error": "AppleScript fetch failed"}

    # 2. parse → Email 对象
    email = reader.parse_email_source(
        full.get("source", ""),
        meta.get("message_id") or full.get("message_id", ""),
        is_read=bool(meta.get("is_read")),
        is_flagged=bool(meta.get("is_flagged")),
    )
    if email is None:
        return {"internal_id": internal_id, "ok": False, "error": "parse_email_source returned None"}
    email.mailbox = mailbox
    email.internal_id = internal_id

    # 3. 用 storage_payload_builder 拼 markdown（path B 的输入源）
    body_payload, _ = build_storage_payloads(
        email,
        internal_id,
        raw_mime_source=full.get("source"),
        attachment_store=store.attachment_store,
    )
    markdown = body_payload.markdown or ""

    # 4. Path A: fallback (repo=None → 走 .content + 正则剥)
    proc_a = LLMProcessor(repo=None)
    fallback_text = proc_a._plaintext_body(email)
    try:
        labels_a = await proc_a.process_email(email)
    except Exception as e:
        await proc_a.close()
        return {"internal_id": internal_id, "ok": False, "error": f"path A LLM error: {e}"}
    await proc_a.close()

    # 5. Path B: SQLite hit (mock repo 返回 markdown)
    proc_b = LLMProcessor(repo=_MockRepo(internal_id, markdown))
    sqlite_text = proc_b._plaintext_body(email)
    try:
        labels_b = await proc_b.process_email(email)
    except Exception as e:
        await proc_b.close()
        return {"internal_id": internal_id, "ok": False, "error": f"path B LLM error: {e}"}
    await proc_b.close()

    # 6. 对比关键字段
    diff: Dict[str, tuple] = {}
    for k in _KEYS:
        a, b = getattr(labels_a, k), getattr(labels_b, k)
        diff[k] = (a, b, a == b)

    return {
        "internal_id": internal_id,
        "subject": (email.subject or "")[:80],
        "mailbox": mailbox,
        "ok": True,
        "fallback_text_len": len(fallback_text),
        "sqlite_md_len": len(sqlite_text),
        "model_a": labels_a.model,
        "model_b": labels_b.model,
        "diff": diff,
        "all_match": all(d[2] for d in diff.values()),
    }


def _print_result(r: Dict[str, Any]) -> None:
    iid = r["internal_id"]
    if not r["ok"]:
        print(f"  ✗ {iid}: ERROR {r['error']}")
        return
    mark = "✓" if r["all_match"] else "✗"
    same_model = r["model_a"] == r["model_b"]
    model_note = f" [model_a={r['model_a']} model_b={r['model_b']}]" if not same_model else ""
    print(
        f"  {mark} {iid} [{r['mailbox']}]: {r['subject']!r}"
        f"  (fallback={r['fallback_text_len']}c, md={r['sqlite_md_len']}c){model_note}"
    )
    if not r["all_match"]:
        for k, (a, b, eq) in r["diff"].items():
            if not eq:
                print(f"      ✗ {k}: A={a!r} ↔ B={b!r}")


def _print_summary(results: List[Dict[str, Any]]) -> None:
    ok = [r for r in results if r["ok"]]
    n = len(ok)
    if n == 0:
        print("\n(no successful comparisons)")
        return

    match_count = sum(1 for r in ok if r["all_match"])
    print(f"\n=== Summary ({n}/{len(results)} ok) ===")
    print(f"  All-fields match: {match_count}/{n} ({100 * match_count / n:.1f}%)")
    print("  Per-field consistency:")
    for k in _KEYS:
        c = sum(1 for r in ok if r["diff"][k][2])
        bar = "█" * int(c / n * 20)
        print(f"    {k:22s} {c:>2}/{n} ({100 * c / n:>5.1f}%) {bar}")

    # 长度对比统计
    avg_fb = sum(r["fallback_text_len"] for r in ok) / n
    avg_md = sum(r["sqlite_md_len"] for r in ok) / n
    print("\n  Input length (avg):")
    print(f"    Path A (fallback regex strip): {avg_fb:>7.0f} chars")
    print(f"    Path B (SQLite markdown):      {avg_md:>7.0f} chars  ({(avg_md - avg_fb) / avg_fb * 100:+.1f}%)")

    # 通过门槛判定
    print("\n  Verdict: ", end="")
    pct = match_count / n
    if pct >= 0.8:
        print(f"✅ PASS (all-match ≥ 80%, observed {pct * 100:.1f}%)")
    elif pct >= 0.6:
        print(f"⚠️  MARGINAL ({pct * 100:.1f}% < 80%) — review diffs above")
    else:
        print(f"❌ FAIL ({pct * 100:.1f}% < 60%) —切换可能导致明显标签漂移")


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--count", type=int, default=10,
                    help="对比邮件数（按最近 synced 顺序选；默认 10）")
    ap.add_argument("--internal-ids", type=str, default="",
                    help="逗号分隔 internal_id 列表，覆盖 --count")
    args = ap.parse_args()

    if args.internal_ids:
        ids = [int(x) for x in args.internal_ids.split(",") if x.strip()]
    else:
        ids = _pick_internal_ids(args.count, cfg.sync_store_db_path)

    if not ids:
        print("No emails to compare.")
        return

    print(f"Comparing {len(ids)} emails (model={cfg.llm_model}):\n  {ids}\n")

    arm = AppleScriptArm(
        account_name=cfg.mail_account_name, inbox_name=cfg.mail_inbox_name
    )
    reader = EmailReader()
    store = EmailRepository(
        db_path=cfg.sync_store_db_path,
        attachment_store=AttachmentStore(cfg.attachment_storage_dir),
    )

    results = []
    for i, iid in enumerate(ids, 1):
        print(f"[{i}/{len(ids)}] {iid}...", flush=True)
        r = await _compare_one(iid, arm, reader, store)
        _print_result(r)
        results.append(r)

    _print_summary(results)


if __name__ == "__main__":
    import warnings

    warnings.warn(
        "scripts/compare_llm_path.py is deprecated; use "
        "'mailagent llm compare-paths' instead. Will be removed in PR-6.",
        DeprecationWarning,
        stacklevel=2,
    )
    asyncio.run(main())
