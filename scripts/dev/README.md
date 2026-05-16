# scripts/dev/

One-off migration scripts, debug harnesses, manual inspection tools, and ad-hoc test runners that aren't part of the production CLI surface.

These files were moved from `scripts/` in PR-5 (2026-05-16) to clean up the top-level `scripts/` directory. They are **not** maintained against the current schema — many will not run cleanly without modification. Use as reference / starting points only.

If you need the functionality of one of these as a real CLI command, port it to `src/cli/commands/` and add tests under `tests/cli/`.

## Categories

- `backfill_*.py` — one-off SQLite migrations (v3 → newer schemas). Already executed in production.
- `check_*.py` — read-only audits against Notion/SQLite. Useful for ad-hoc debugging.
- `debug_*.py` — debug harnesses for specific subsystems (eventkit, conversion, payload inspection).
- `inspect_*.py` — manual inspection of latest/unread emails.
- `test_*.py` — manual test harnesses (NOT pytest unit tests; those live under `tests/`).
- `manual_sync.py` — one-off manual sync replacement, predates `mailagent` CLI.
- `migrate_sync_store_v3.py` — v2→v3 schema migration (executed once).
- `poc_markdown_api.py` — Notion Markdown API PoC.
