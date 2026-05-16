#!/usr/bin/env python3
"""CLI for manually running the LLM agent on one or many emails.

Examples:
  # Gateway health check (cheap, no Notion writes):
  python scripts/run_llm_on_email.py --selftest

  # Dry-run a single email (no Notion write, just see what LLM returns):
  python scripts/run_llm_on_email.py --internal-id 51793 --dry-run

  # Real run on a single email (writes 11 AI fields + Processing Status to Notion):
  python scripts/run_llm_on_email.py --internal-id 51793 --force

  # Re-run a range, keeping existing non-empty fields (safe refill):
  python scripts/run_llm_on_email.py --internal-ids 51000-51100 --force --no-overwrite

Requires:
  - .env with LLM_API_KEY / LLM_API_BASE (and optionally LLM_CONTEXT_PAGE_ID, LLM_DAILY_DIGEST_DATABASE_ID)
  - ntn_ prefixed NOTION_TOKEN (Markdown API requires it)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import List

# Ensure project root is on sys.path when run as a script
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def parse_ids(spec: str) -> List[int]:
    out: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


async def cmd_selftest() -> int:
    """Minimal LLM call to verify gateway + tool_use + enum are healthy."""
    # Force-enable so the config checks don't short-circuit
    os.environ.setdefault("LLM_AGENT_ENABLED", "true")

    from src.llm_agent import AnthropicClient, EMAIL_TOOL_SCHEMA

    client = AnthropicClient()
    try:
        result = await client.classify(
            system_blocks=[
                {
                    "type": "text",
                    "text": (
                        "You are an email triage assistant. Call classify_email "
                        "EXACTLY ONCE. Never emit plain text."
                    ),
                }
            ],
            user_content=(
                "Classify this test email:\n\n"
                "Subject: Q3 review meeting prep\n"
                "From: Gary Wen <gary.wen@tp-link.com>\n"
                "Date: 2026-04-23T10:00:00-07:00\n\n"
                "Please prep the roadmap deck before Friday's review."
            ),
            tool_schema=EMAIL_TOOL_SCHEMA,
            tool_name="classify_email",
        )
    finally:
        await client.close()

    print(json.dumps({
        "ok": True,
        "model": result.model,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "cache_creation_input_tokens": result.cache_creation_input_tokens,
        "cache_read_input_tokens": result.cache_read_input_tokens,
        "latency_ms": result.latency_ms,
        "tool_input_preview": {
            k: (v[:80] if isinstance(v, str) else v)
            for k, v in (result.tool_input or {}).items()
        },
    }, indent=2, ensure_ascii=False))
    return 0


async def cmd_run(args) -> int:
    # Force-enable so the config checks don't short-circuit
    os.environ.setdefault("LLM_AGENT_ENABLED", "true")

    from src.llm_agent import LLMRunner

    ids: List[int] = []
    if args.internal_ids:
        ids.extend(parse_ids(args.internal_ids))
    if args.internal_id is not None:
        ids.append(int(args.internal_id))
    if not ids:
        print("error: no internal_id given", file=sys.stderr)
        return 2

    runner = LLMRunner()
    failed = 0
    try:
        for iid in ids:
            print(f"\n==== internal_id={iid} ====")
            r = await runner.run_for_internal_id(
                iid,
                dry_run=args.dry_run,
                force=args.force,
                overwrite=args.overwrite,
            )
            print(json.dumps(r, indent=2, ensure_ascii=False))
            if not r.get("ok"):
                failed += 1
    finally:
        await runner.close()

    total = len(ids)
    ok = total - failed
    print(f"\n==== total={total} ok={ok} failed={failed} ====")
    return 0 if failed == 0 else 1


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Run LLM agent against one or many emails",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Tips:\n"
            "  --dry-run prints the labels and target properties without writing Notion.\n"
            "  --no-overwrite keeps any existing non-empty Notion fields untouched (safe refill).\n"
            "  --force re-runs even if llm_processing already shows success.\n"
            "  --selftest only pokes the gateway; does NOT touch Notion or sync_store.\n"
        ),
    )
    ap.add_argument("--internal-id", type=int, help="Single email internal_id (SQLite ROWID)")
    ap.add_argument("--internal-ids", type=str, help="Comma-sep list or range (e.g. 100,102-105)")
    ap.add_argument("--dry-run", action="store_true", help="Don't write Notion; print what would be written")
    ap.add_argument("--force", action="store_true", help="Re-run even if already marked success")
    ap.add_argument(
        "--overwrite", action="store_true", default=True,
        help="LLM output wins over existing non-empty fields (default)",
    )
    ap.add_argument(
        "--no-overwrite", dest="overwrite", action="store_false",
        help="Keep existing non-empty fields; only fill blanks + advance Processing Status",
    )
    ap.add_argument("--selftest", action="store_true", help="Health-check the LLM gateway")
    return ap


def main() -> int:
    ap = build_argparser()
    args = ap.parse_args()
    if args.selftest:
        return asyncio.run(cmd_selftest())
    if args.internal_id is None and not args.internal_ids:
        ap.error("--internal-id or --internal-ids required (or --selftest)")
    return asyncio.run(cmd_run(args))


if __name__ == "__main__":
    import warnings

    warnings.warn(
        "scripts/run_llm_on_email.py is deprecated; use "
        "'mailagent llm run' instead. Will be removed in PR-6.",
        DeprecationWarning,
        stacklevel=2,
    )
    sys.exit(main() or 0)
