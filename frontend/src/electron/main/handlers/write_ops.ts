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
//   email:flag         → mailagent email flag <id> [--is-read|--is-flagged|--processing-status]
//                        Sprint 15 SSoT inversion. 批量: email:flag(null, {ids, ...}) → --ids.
//                        Always passes --allow-concurrent (pm2 mail-sync is always online
//                        in the frontend's environment) unless opts.allowConcurrent === false.
//   llm:run            → mailagent llm run <id> [--dry-run|--force|--no-overwrite]
//   notion:updateFlag  → mailagent notion update-flag <id> [--is-read|--is-flagged|--processing-status]
//                        Legacy path kept during Sprint 15 grayscale; planned to be deleted one
//                        week after `email:flag` stabilises (see frontend/SPRINT15-D handoff §6).
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
import { getWriteDb } from '../db'
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

/** Sprint 15 — `mailagent email flag` (writes SQLite intent + outbox dual target).
 *  Replaces the v3 `notion.updateFlag` path; see frontend/SPRINT15-D handoff §3.1. */
export interface EmailFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  /** Notion-only column (SQLite doesn't store this). Same enum as UpdateFlagOpts. */
  processingStatus?: string
  /** Batch mode: ids ↔ internalId are mutually exclusive at the CLI level.
   *  When supplied, the handler ignores the `internalId` positional arg. */
  ids?: number[]
  /** Defaults to true — mail-sync is always online in the frontend's
   *  environment, so the CLI's pm2 conflict check needs to be bypassed.
   *  Pass `false` explicitly only from tests / dry-run UI experiments. */
  allowConcurrent?: boolean
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

function archiveArgs(internalId: number): string[] {
  return ['email', 'archive', String(internalId), '-o', 'json']
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

/**
 * Sprint 15 — `mailagent email flag` argv builder.
 *
 * The CLI uses typer's `--flag/--no-flag` pattern (NOT `--flag <bool>` like
 * `notion update-flag` does), so we emit bare `--is-read` / `--no-is-read`
 * tokens. See src/cli/commands/email.py:1058-1064.
 *
 * Single email: pass `internalId` and leave `opts.ids` undefined.
 * Batch:        pass `internalId = null` and supply `opts.ids = [1, 2, 3]`.
 * The two are mutually exclusive at the CLI level (E_INVALID_ARG otherwise);
 * the handler that wraps this builder enforces the same precondition.
 */
function emailFlagArgs(internalId: number | null, opts: EmailFlagOpts): string[] {
  const args = ['email', 'flag']
  if (Array.isArray(opts.ids) && opts.ids.length > 0) {
    args.push('--ids', opts.ids.join(','))
  } else if (typeof internalId === 'number') {
    args.push(String(internalId))
  } else {
    // Caller contract violation; handler should have short-circuited already.
    throw new Error('emailFlagArgs requires either internalId or opts.ids')
  }
  if (opts.isRead === true) args.push('--is-read')
  else if (opts.isRead === false) args.push('--no-is-read')
  if (opts.isFlagged === true) args.push('--is-flagged')
  else if (opts.isFlagged === false) args.push('--no-is-flagged')
  if (typeof opts.processingStatus === 'string' && opts.processingStatus.length > 0) {
    args.push('--processing-status', opts.processingStatus)
  }
  if (opts.allowConcurrent !== false) args.push('--allow-concurrent')
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
/** email flag writes SQLite + outbox rows only (no upstream IO). Even a 50-id
 *  batch is a handful of SQL INSERTs, so 30s is generous. Fanout dispatch is
 *  async on mail-sync's side, not part of this CLI call. */
const EMAIL_FLAG_TIMEOUT_MS = 30_000
/** pin / unpin is a single-row UPDATE; bounded very short. */
const PIN_TIMEOUT_MS = 10_000

/** archive forks IMAP MOVE (INBOX→Archive) + a Notion property update; allow
 *  for a slow DavMail round-trip without pre-empting an otherwise-healthy move. */
const ARCHIVE_TIMEOUT_MS = 60_000

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

export async function runArchive(internalId: number): Promise<unknown> {
  return callCli(archiveArgs(internalId), {
    write: true,
    needsAuth: true,
    timeoutMs: ARCHIVE_TIMEOUT_MS
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

/** Sprint 16 收尾 — IPC 直写 SQLite. flag/read/processing_status 操作不再 fork
 *  Python CLI (~500-1000ms), 直接 better-sqlite3 transaction 写 email_metadata
 *  + email_outbox dual target. mail-sync FanoutWorker 5s 内拾取派发 Mail.app
 *  + Notion. 跟 CLI 路径行为等价, 仅延迟从 ~500ms 降到 ~5ms.
 *
 *  Echo prevention 跟 Python OutboxRepository.enqueue 一致: source 永不传
 *  'notion_webhook' (那是 webhook handler 专用), 所以 target='notion' 一律
 *  允许写入.
 */
export function writeFlagDirect(
  internalId: number,
  opts: UpdateFlagOpts
):
  | { ok: true; data: { outbox_ids: number[]; merged_ids: number[] } }
  | { ok: false; code: string; message: string } {
  // 至少一个字段非空 (handler 层已经 guard, 这里 defensive)
  if (
    opts.isRead === undefined &&
    opts.isFlagged === undefined &&
    (typeof opts.processingStatus !== 'string' || opts.processingStatus.length === 0)
  ) {
    return {
      ok: false,
      code: 'E_INVALID_ARG',
      message: 'writeFlagDirect requires at least one of isRead / isFlagged / processingStatus'
    }
  }

  try {
    const db = getWriteDb()
    const now = Date.now() / 1000

    // 1. UPDATE email_metadata: 部分字段 SET (跟 sync_store.update_local_flags 对齐)
    const setParts: string[] = []
    const setArgs: unknown[] = []
    if (opts.isRead !== undefined) {
      setParts.push('is_read = ?')
      setArgs.push(opts.isRead ? 1 : 0)
    }
    if (opts.isFlagged !== undefined) {
      setParts.push('is_flagged = ?')
      setArgs.push(opts.isFlagged ? 1 : 0)
    }
    if (typeof opts.processingStatus === 'string' && opts.processingStatus.length > 0) {
      setParts.push('processing_status = ?')
      setArgs.push(opts.processingStatus)
    }
    setParts.push('updated_at = ?')
    setArgs.push(now)
    setArgs.push(internalId)

    // 2. payload — outbox 派发到 Mail.app / Notion 用. Mail.app 只关心 read/flagged,
    //    processing_status 是 Notion-only 字段 (Mail.app side 没对应概念).
    const mailappPayload: Record<string, unknown> = {}
    const notionPayload: Record<string, unknown> = {}
    if (opts.isRead !== undefined) {
      mailappPayload['is_read'] = opts.isRead
      notionPayload['is_read'] = opts.isRead
    }
    if (opts.isFlagged !== undefined) {
      mailappPayload['is_flagged'] = opts.isFlagged
      notionPayload['is_flagged'] = opts.isFlagged
    }
    if (typeof opts.processingStatus === 'string' && opts.processingStatus.length > 0) {
      notionPayload['processing_status'] = opts.processingStatus
    }

    // 3. transaction: UPDATE 主表 + 双 enqueue (mailapp + notion)
    const tx = db.transaction(() => {
      // metadata 主表
      const result = db
        .prepare(`UPDATE email_metadata SET ${setParts.join(', ')} WHERE internal_id = ?`)
        .run(...setArgs)
      if (result.changes === 0) {
        // 邮件不存在 — 阻止后续 outbox 写入避免脏数据
        throw new Error(`email_metadata.internal_id=${internalId} not found`)
      }

      const outboxIds: number[] = []
      const mergedIds: number[] = []

      // B1: 单条原子 UPSERT, 与 Python OutboxRepository.enqueue 同一条 SQL (语义真源
      // = SQLite 引擎, 不再两份手抄 merge + 消读-改-写竞态). 命中 partial unique index
      // ux_outbox_pending_intent (同 internal_id+op_type+target 且 status='pending') →
      // DO UPDATE json_patch (后写覆盖同 key, RFC7396); 否则 INSERT 新行. was_inserted
      // (INSERT 时 created_at==updated_at) 区分 outboxIds / mergedIds.
      const enqueueOne = (target: 'mailapp' | 'notion', payload: Record<string, unknown>) => {
        if (Object.keys(payload).length === 0) return // 空 payload 跳过
        // 紧凑 sorted —— 与 Python json.dumps(sort_keys, separators) + SQL json_patch
        // 输出逐字节一致 (B1 契约: write_ops_outbox_parity.test.ts ↔ test_outbox_parity.py).
        const payloadJson = JSON.stringify(payload, Object.keys(payload).sort())
        const row = db
          .prepare(
            `INSERT INTO email_outbox
               (internal_id, op_type, target, payload_json, source,
                status, attempts, last_error, next_retry_at, created_at, updated_at)
             VALUES (?, 'flag_sync', ?, ?, 'frontend_direct',
                     'pending', 0, NULL, NULL, ?, ?)
             ON CONFLICT(internal_id, op_type, target) WHERE status = 'pending'
             DO UPDATE SET
               payload_json = json_patch(payload_json, excluded.payload_json),
               source = COALESCE(excluded.source, source),
               updated_at = excluded.updated_at
             RETURNING outbox_id, (created_at = updated_at) AS was_inserted`
          )
          .get(internalId, target, payloadJson, now, now) as {
          outbox_id: number
          was_inserted: number
        }
        if (row.was_inserted) outboxIds.push(Number(row.outbox_id))
        else mergedIds.push(Number(row.outbox_id))
      }

      enqueueOne('mailapp', mailappPayload)
      enqueueOne('notion', notionPayload)

      return { outbox_ids: outboxIds, merged_ids: mergedIds }
    })

    const out = tx()
    return { ok: true, data: out }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'E_WRITE_DIRECT', message }
  }
}

/** Sprint 15 — `mailagent email flag` execution wrapper. Treated as a write
 *  (always needs auth + a queue write slot) since it inserts outbox rows even
 *  in batch mode. No dry-run knob plumbed yet (the CLI supports `--dry-run`
 *  but the renderer never exercises it; add when a "preview" UI lands). */
export async function runEmailFlag(
  internalId: number | null,
  opts: EmailFlagOpts = {}
): Promise<unknown> {
  return callCli(emailFlagArgs(internalId, opts), {
    write: true,
    needsAuth: true,
    timeoutMs: EMAIL_FLAG_TIMEOUT_MS
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
    'email:archive',
    async (_evt, internalId: unknown): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'email:archive')
      if (typeof idOrErr !== 'number') return idOrErr
      return envelopeFromCli(runArchive(idOrErr))
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
      // Sprint 16 收尾 — 非 dry-run 走 IPC 直写 SQLite (~5ms), 不再 fork CLI.
      // dry-run 仍走 CLI (它会跑完整校验 + 输出 schema-validated 结果, 给 preview UI 用).
      if (!o.dryRun) {
        return writeFlagDirect(idOrErr, o)
      }
      return envelopeFromCli(runUpdateFlag(idOrErr, o))
    }
  )

  // Sprint 15 — SSoT inversion. Mirrors notion:updateFlag's preconditions
  // (≥1 field set) but adds a batch mode: pass `internalId = null` together
  // with `opts.ids = [...]` to enqueue many outbox rows in one CLI fork.
  ipcMain.handle(
    'email:flag',
    async (
      _evt,
      internalId: unknown,
      opts: EmailFlagOpts = {}
    ): Promise<WriteEnvelope<unknown>> => {
      const o = opts ?? {}

      // ≥1 field must be touched — same UX guard as notion:updateFlag.
      if (
        o.isRead === undefined &&
        o.isFlagged === undefined &&
        (typeof o.processingStatus !== 'string' || o.processingStatus.length === 0)
      ) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'email:flag requires at least one of isRead / isFlagged / processingStatus'
        }
      }

      // Batch mode — bypass ensureInternalId; the CLI accepts `--ids 1,2,3`.
      if (Array.isArray(o.ids) && o.ids.length > 0) {
        // Defensive: every id must be a non-negative integer or the CLI
        // will return E_INVALID_ARG after we paid the fork cost.
        for (const id of o.ids) {
          if (!Number.isInteger(id) || (id as number) < 0) {
            return {
              ok: false,
              code: 'E_INVALID_ARG',
              message: `email:flag: opts.ids contains non-integer id ${String(id)}`
            }
          }
        }
        return envelopeFromCli(runEmailFlag(null, o))
      }

      // Single-row path — same validation as the other write handlers.
      const idOrErr = ensureInternalId(internalId, 'email:flag')
      if (typeof idOrErr !== 'number') return idOrErr
      // Sprint 16 收尾 — 单行非 batch 走 IPC 直写 SQLite (~5ms). batch mode 仍
      // 走 CLI (CLI 已有完整 batch 报告 + checkpoint resume, 不重新造轮子).
      // EmailFlagOpts 跟 UpdateFlagOpts 字段子集 (allowConcurrent 是 CLI-only,
      // direct write 不需要 — 没有 pm2 conflict 概念).
      return writeFlagDirect(idOrErr, {
        isRead: o.isRead,
        isFlagged: o.isFlagged,
        processingStatus: o.processingStatus
      })
    }
  )
}

// ---- test escape hatch -----------------------------------------------------

export const __testing = {
  resyncArgs,
  llmRunArgs,
  updateFlagArgs,
  emailFlagArgs,
  archiveArgs,
  envelopeFromCli,
  ensureInternalId
}
