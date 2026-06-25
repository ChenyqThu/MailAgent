// chat-panel P4 Phase 06a (cutover) — backfill ai_chat_messages.ui_message_json for legacy rows.
//
// Pre-v9 / legacy-runtime rows have ui_message_json = NULL; the AI SDK reload path synthesizes a
// UIMessage from `content` on the fly, but materializing the canonical JSON once lets search / preview
// read the same SSoT and removes the per-reload synth. This is a ONE-OFF, idempotent migration:
//   - only rows WHERE ui_message_json IS NULL are touched (never overwrites an existing UIMessage),
//   - --dry-run reports the counts and writes nothing,
//   - a row that fails to convert is logged and skipped (the run never aborts).
//
// Run (electron-as-node, so better-sqlite3 loads the Electron ABI the app uses):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
//     node_modules/.bin/tsx scripts/chat/backfill-ui-messages.ts --db <path/to/ai_chat.db> [--dry-run]
// or, after `pnpm rebuild:node`, plain: npx tsx scripts/chat/backfill-ui-messages.ts --db <path> --dry-run
// The DB path is required (--db or AI_CHAT_DB_PATH) so this never guesses the wrong store; the script
// opens better-sqlite3 directly (NOT chat_db.ts) to avoid pulling in the Electron app-path resolver.

import Database from 'better-sqlite3'

import {
  chatMessageToUIMessage,
  type MailAgentUIMessage,
  type ReloadableChatMessageRow
} from '../../src/shared/assistant/uiMessage'

export interface BackfillResult {
  /** Rows with ui_message_json IS NULL that were scanned. */
  scanned: number
  /** Rows whose ui_message_json was written (or, in dry-run, WOULD be written). */
  filled: number
  /** Rows that failed to convert and were skipped (never aborts the run). */
  failed: number
}

type LegacyRow = ReloadableChatMessageRow & { id: number }

/** Backfill ui_message_json for every ai_chat_messages row that lacks it. Pure data access — the
 *  caller owns the better-sqlite3 handle (so the migration runs in the same tx discipline as the app
 *  and the test can drive a tmp DB). `convert` is injectable so a test can exercise the
 *  failure-is-skipped path; production uses chatMessageToUIMessage. Idempotent: the UPDATE re-checks
 *  `ui_message_json IS NULL`, so a concurrent / repeated run never clobbers an existing UIMessage. */
export function backfillUiMessages(
  db: Database.Database,
  opts: { dryRun?: boolean; convert?: (row: ReloadableChatMessageRow) => MailAgentUIMessage } = {}
): BackfillResult {
  const convert = opts.convert ?? chatMessageToUIMessage
  const rows = db
    .prepare(
      `SELECT id, role, content, thinking, model, tokens_input, tokens_output
         FROM ai_chat_messages
        WHERE ui_message_json IS NULL`
    )
    .all() as LegacyRow[]
  const update = db.prepare(
    `UPDATE ai_chat_messages SET ui_message_json = ? WHERE id = ? AND ui_message_json IS NULL`
  )

  let filled = 0
  let failed = 0
  for (const row of rows) {
    try {
      const json = JSON.stringify(convert(row))
      if (opts.dryRun) {
        filled++
      } else {
        const res = update.run(json, row.id)
        if (res.changes > 0) filled++
      }
    } catch (err) {
      failed++
      console.error(`[backfill] row ${row.id} failed to convert — skipped:`, err)
    }
  }
  return { scanned: rows.length, filled, failed }
}

function resolveDbPathFromArgs(argv: string[]): string | null {
  const i = argv.indexOf('--db')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return process.env.AI_CHAT_DB_PATH ?? null
}

/** CLI entrypoint — parse flags, open the DB, run the backfill, print the counts. */
export function runBackfillCli(argv: string[] = process.argv.slice(2)): number {
  const dryRun = argv.includes('--dry-run')
  const dbPath = resolveDbPathFromArgs(argv)
  if (!dbPath) {
    console.error('[backfill] no DB path — pass --db <path/to/ai_chat.db> or set AI_CHAT_DB_PATH')
    return 2
  }
  const db = new Database(dbPath, { readonly: dryRun })
  try {
    const result = backfillUiMessages(db, { dryRun })
    const verb = dryRun ? 'would fill' : 'filled'
    console.log(
      `[backfill] ${dryRun ? '(dry-run) ' : ''}scanned ${result.scanned} NULL rows · ${verb} ${result.filled} · ${result.failed} failed`
    )
    return 0
  } finally {
    db.close()
  }
}

// Run as a CLI only when invoked directly (not when imported by the test — process.argv[1] is then
// the vitest runner, so the guard is false and importing has no side effect).
if (process.argv[1] && /backfill-ui-messages(\.ts|\.js)?$/.test(process.argv[1])) {
  process.exit(runBackfillCli())
}
