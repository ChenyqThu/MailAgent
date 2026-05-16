# scripts/archive/

Truly historical one-off scripts — **already executed in production, will not run cleanly against the current schema, kept only for reference / audit trail**.

Moved here from `scripts/` / `scripts/dev/` in PR-5 (2026-05-16) to clarify scope:

- `scripts/` — production-facing scripts (mostly deprecated thin wrappers + a couple of `.sh` deploy / clipboard utilities)
- `scripts/dev/` — debug / inspection / manual-test harnesses still occasionally useful
- `scripts/archive/` (this dir) — one-shot historical migrations / PoCs that should NEVER run again

## What's here

| Script | When run | Why kept |
|---|---|---|
| `backfill_internal_id.py` | 2026-01, v3 architecture migration | Populated `email_metadata.internal_id` PK from old `message_id` PK |
| `backfill_notion_id.py` | 2026-01 (early v2) | Wrote Notion `page_id` back onto SyncStore rows that predated the relation |
| `migrate_sync_store_v3.py` | 2026-01 v2 → v3 schema cutover | One-shot ALTER TABLE + index rebuild; `db_version` 2 → 3 |
| `poc_markdown_api.py` | 2026-04 | PoC for Notion Markdown API endpoint behavior (file_upload not supported) — superseded by `docs/notion_markdown_api.md` |

## Do NOT

- Do NOT run these against the current production database — they assume schema versions that no longer exist.
- Do NOT delete them — they document the historical migration path in `git log`.
- Do NOT port logic from these into new CLI commands without checking against the current schema (`db_version=6`).

If you need a similar one-off task today, write a fresh script under `scripts/dev/` or, better, expose it as a `mailagent` subcommand.
