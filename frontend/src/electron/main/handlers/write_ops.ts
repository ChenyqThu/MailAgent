// Sprint 5 §2.2 — CLI-backed write IPC handlers.
//
// Three write surfaces ride on top of the Sprint 1 `cli_runner.callCli`
// (REVIEW-LOG C-02): they fork `mailagent <group> <action>` and translate
// the JSON envelope into a renderer-friendly `{ ok, data }` / `{ ok: false,
// code, message }` shape. The envelope pattern mirrors translate.ts / chat.ts
// because Electron IPC drops custom Error properties (codex review M-3) and
// the renderer needs `code` to branch on E_AUTH / E_QUOTA / E_PM2_CONFLICT.
//
// Channels:
//   email:resync       → mailagent email resync <id> [--dry-run|--replace-existing|--no-parent]
//   email:pin          → mailagent email pin <id> [--dry-run]
//   email:unpin        → mailagent email unpin <id> [--dry-run]
//   llm:run            → mailagent llm run <id> [--dry-run|--force|--no-overwrite]
//   notion:updateFlag  → mailagent notion update-flag <id> [--is-read|--is-flagged|--processing-status]
//
// Long-task semantics (PROJECT-PLAN.md §2 Sprint 5 / handoff §2.2):
//   - V1 ships single-id single-shot. Each CLI call returns one JSON
//     envelope and is timed-bound by cli_runner's per-call deadline.
//   - Batch wrappers (BatchActionBar — multi-id loop with progress + SIGINT
//     dialog) live in Sprint 5 Day 4 in a separate channel that delegates
//     to these same functions per unit; this file stays single-unit.
//
// Auth: writes require MAILAGENT_CLI_API_KEY (the backend enforces it via
// CLI env policy). cli_runner.callCli({ needsAuth: true }) injects the key
// from keytar before fork. --dry-run skips auth (mirroring CLI behavior).

import { ipcMain } from 'electron'

import { callCli } from '../cli_runner'
import { ensureInternalId, envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

// ---- request shapes -------------------------------------------------------

export interface ResyncOpts {
  replaceExisting?: boolean
  skipParentLookup?: boolean
  dryRun?: boolean
}

export interface PinOpts {
  dryRun?: boolean
}

export interface LlmRunOpts {
  dryRun?: boolean
  /** Overwrite existing AI fields. Without this the CLI no-ops if labels exist. */
  force?: boolean
  /** Preserve user-edited non-null fields when force=true. */
  noOverwrite?: boolean
}

export interface UpdateFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  /** Notion DB enum: 未处理 / AI Reviewed / 已同步 / 已完成 / 草稿已创建. */
  processingStatus?: string
  dryRun?: boolean
}

// Sprint 7 Day 1 — `WriteEnvelope<T>`, `envelopeFromCli`, `ensureInternalId`
// were extracted to `src/electron/main/lib/envelope.ts` (Sprint 6 review opus
// LOW carry-forward — the same three pieces lived in admin.ts / calendar.ts
// / write_ops.ts and risked drift). Re-exported here so the published surface
// of this module is unchanged for tests / external imports.
export type { WriteEnvelope } from '../lib/envelope'

// ---- CLI arg builders -----------------------------------------------------

function resyncArgs(internalId: number, opts: ResyncOpts): string[] {
  const args = ['email', 'resync', String(internalId)]
  if (opts.dryRun) args.push('--dry-run')
  if (opts.replaceExisting) args.push('--replace-existing')
  if (opts.skipParentLookup) args.push('--no-parent')
  return args
}

function pinArgs(internalId: number, pinned: boolean, opts: PinOpts): string[] {
  const args = ['email', pinned ? 'pin' : 'unpin', String(internalId)]
  if (opts.dryRun) args.push('--dry-run')
  return args
}

function llmRunArgs(internalId: number, opts: LlmRunOpts): string[] {
  const args = ['llm', 'run', String(internalId)]
  if (opts.dryRun) args.push('--dry-run')
  if (opts.force) args.push('--force')
  if (opts.noOverwrite) args.push('--no-overwrite')
  return args
}

function updateFlagArgs(internalId: number, opts: UpdateFlagOpts): string[] {
  const args = ['notion', 'update-flag', String(internalId)]
  if (opts.dryRun) args.push('--dry-run')
  if (opts.isRead !== undefined) {
    args.push('--is-read', opts.isRead ? 'true' : 'false')
  }
  if (opts.isFlagged !== undefined) {
    args.push('--is-flagged', opts.isFlagged ? 'true' : 'false')
  }
  if (typeof opts.processingStatus === 'string' && opts.processingStatus.length > 0) {
    args.push('--processing-status', opts.processingStatus)
  }
  return args
}

// ---- executions (unit-testable) -------------------------------------------

/** Resync timeout: Notion block upload runs sequentially, ~50-150ms each;
 *  100+ inline-image emails can take ~30s; bound at 2min so a stuck
 *  upstream doesn't wedge a write slot indefinitely. */
const RESYNC_TIMEOUT_MS = 120_000
/** LLM round-trip + cache miss + retry headroom. */
const LLM_RUN_TIMEOUT_MS = 90_000
/** notion update-flag is a single PATCH; bounded short. */
const UPDATE_FLAG_TIMEOUT_MS = 30_000
/** pin / unpin is a single-row UPDATE; bounded very short. */
const PIN_TIMEOUT_MS = 10_000

export async function runResync(internalId: number, opts: ResyncOpts = {}): Promise<unknown> {
  return callCli(resyncArgs(internalId, opts), {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: RESYNC_TIMEOUT_MS
  })
}

export async function runPin(
  internalId: number,
  pinned: boolean,
  opts: PinOpts = {}
): Promise<unknown> {
  return callCli(pinArgs(internalId, pinned, opts), {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: PIN_TIMEOUT_MS
  })
}

export async function runLlmRun(internalId: number, opts: LlmRunOpts = {}): Promise<unknown> {
  return callCli(llmRunArgs(internalId, opts), {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: LLM_RUN_TIMEOUT_MS
  })
}

export async function runUpdateFlag(
  internalId: number,
  opts: UpdateFlagOpts = {}
): Promise<unknown> {
  return callCli(updateFlagArgs(internalId, opts), {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: UPDATE_FLAG_TIMEOUT_MS
  })
}

// ---- IPC wiring ------------------------------------------------------------

export function registerWriteOpsHandlers(): void {
  ipcMain.handle(
    'email:resync',
    async (_evt, internalId: unknown, opts: ResyncOpts = {}): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'email:resync')
      if (typeof idOrErr !== 'number') return idOrErr
      return envelopeFromCli(runResync(idOrErr, opts ?? {}))
    }
  )

  ipcMain.handle(
    'email:pin',
    async (
      _evt,
      internalId: unknown,
      pinned: unknown,
      opts: PinOpts = {}
    ): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'email:pin')
      if (typeof idOrErr !== 'number') return idOrErr
      if (typeof pinned !== 'boolean') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: `email:pin expected boolean pinned, got ${typeof pinned}`
        }
      }
      return envelopeFromCli(runPin(idOrErr, pinned, opts ?? {}))
    }
  )

  ipcMain.handle(
    'llm:run',
    async (_evt, internalId: unknown, opts: LlmRunOpts = {}): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'llm:run')
      if (typeof idOrErr !== 'number') return idOrErr
      return envelopeFromCli(runLlmRun(idOrErr, opts ?? {}))
    }
  )

  ipcMain.handle(
    'notion:updateFlag',
    async (
      _evt,
      internalId: unknown,
      opts: UpdateFlagOpts = {}
    ): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'notion:updateFlag')
      if (typeof idOrErr !== 'number') return idOrErr
      const o = opts ?? {}
      // The CLI itself fails E_INVALID_ARG when no flag is supplied, but
      // catching it here avoids burning a subprocess fork on a UI bug.
      if (
        o.isRead === undefined &&
        o.isFlagged === undefined &&
        (typeof o.processingStatus !== 'string' || o.processingStatus.length === 0)
      ) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message:
            'notion:updateFlag requires at least one of isRead / isFlagged / processingStatus'
        }
      }
      return envelopeFromCli(runUpdateFlag(idOrErr, o))
    }
  )
}

// ---- test escape hatch -----------------------------------------------------

export const __testing = {
  resyncArgs,
  llmRunArgs,
  updateFlagArgs,
  envelopeFromCli,
  ensureInternalId
}
