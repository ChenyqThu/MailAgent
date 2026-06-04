// D1 — 写操作 IPC handler。统一收编到本机 daemon (serve-api in-process service)。
//
// 演进: Sprint 5 这些写 fork `mailagent <group> <action>` (callCli, ~500-1000ms);
// Sprint 16 flag 单行改 IPC 直写 SQLite (~5ms)。D1 全部收编 —— handler
// 内部经 daemonRequest 转发本机 serve-api (127.0.0.1:8200, 带 C2 本地 token), 写源从 4
// 收敛到 1 (daemon service)。**renderer / ElectronApi 零改动**: 仍走这些 IPC channel,
// 只是 main 侧实现从 fork/直写 换成 HTTP 转发; envelope 契约 ({ok,data}/{ok,code,message})
// 不变。
//
// parity: daemon 路径返回的 data 块与原 CLI data 块逐字段一致 (A2-A4 service==CLI
// golden 保证), 故 resync/pin/archive/llm/flag-batch renderer 形状零变化。flag 单行从
// 旧 IPC 直写路径的 {outbox_ids,merged_ids} 改成 daemon FlagResult
// ({updated_ids,outbox_entries,payload,...}) —— renderer 组件 (EmailRow /
// useInboxActionShortcuts / CommandPalette) 只 await 不读 data, 唯一读字段的 chat 写工具
// 已同步适配 (chat/tools/builtin/write.ts)。
//
// 前提: serve-api 在跑 (打包态 BackendLifecycleManager flip 后恒起)。daemon 挂 → 写抛
// E_NETWORK (诚实降级, 读仍 IPC 直读 SQLite)。各 daemonRequest 的 path/body/query 严格
// mirror @shared/api/HttpApi 对应方法 (见 daemon_api.ts)。

import { ipcMain } from 'electron'

import type { EmailFlagOpts, LlmRunOpts, ResyncOpts, UpdateFlagOpts } from '@shared/api/types'

import { daemonRequest } from '../daemon_api'
import { ensureInternalId, envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

// Re-exported so the published surface of this module is unchanged for tests /
// external imports (Sprint 7 Day 1 — envelope helpers live in lib/envelope.ts).
export type { WriteEnvelope } from '../lib/envelope'

// ---- flag body builder (mirror HttpApi.email.flag wire) -------------------

/** Serve-api flag body — only non-undefined fields, matching HttpApi.email.flag.
 *  The server reads isRead / isFlagged / processingStatus (camelCase aliases) +
 *  optional ids[] for batch. allowConcurrent is NEVER sent: the server forces
 *  --allow-concurrent (mail-sync is always online), so there's no pm2 conflict
 *  to bypass from the client. Exported for parity unit tests. */
function flagBody(opts: {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
  ids?: number[]
}): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (opts.isRead !== undefined) body.isRead = opts.isRead
  if (opts.isFlagged !== undefined) body.isFlagged = opts.isFlagged
  if (typeof opts.processingStatus === 'string' && opts.processingStatus.length > 0) {
    body.processingStatus = opts.processingStatus
  }
  if (Array.isArray(opts.ids) && opts.ids.length > 0) body.ids = opts.ids
  return body
}

// ---- daemon forwarders (unit-testable: tests mock daemonRequest) ----------

export async function runResync(internalId: number, opts: ResyncOpts = {}): Promise<unknown> {
  // mirror HttpApi.email.resync — POST /email/{id}/resync, camelCase body.
  return daemonRequest('POST', `/email/${internalId}/resync`, {
    body: {
      replaceExisting: opts.replaceExisting,
      skipParentLookup: opts.skipParentLookup,
      dryRun: opts.dryRun
    }
  })
}

export async function runPin(internalId: number, pinned: boolean): Promise<unknown> {
  // mirror HttpApi.email.pin — POST /email/{id}/pin {pinned}. Returns the full
  // {internal_id,is_pinned,changed,dry_run} data block (NOT unwrapped to a bool
  // like HttpApi does) so ElectronApi.pin's `data?.is_pinned` keeps working.
  return daemonRequest('POST', `/email/${internalId}/pin`, { body: { pinned } })
}

export async function runArchive(internalId: number): Promise<unknown> {
  // mirror HttpApi.email.archive — POST /email/{id}/archive {}.
  return daemonRequest('POST', `/email/${internalId}/archive`, { body: {} })
}

export async function runLlmRun(internalId: number, opts: LlmRunOpts = {}): Promise<unknown> {
  // mirror HttpApi.llm.run — POST /llm/run/{id} with QUERY params (not body).
  return daemonRequest('POST', `/llm/run/${internalId}`, {
    query: { dry_run: opts.dryRun, force: opts.force, no_overwrite: opts.noOverwrite }
  })
}

/** Single-row or batch flag. mirror HttpApi.email.flag — batch (opts.ids) posts
 *  to /email/0/flag with body.ids (server ignores the path id), single posts to
 *  /email/{id}/flag. */
export async function runEmailFlag(
  internalId: number | null,
  opts: EmailFlagOpts = {}
): Promise<unknown> {
  if (Array.isArray(opts.ids) && opts.ids.length > 0) {
    return daemonRequest('POST', '/email/0/flag', { body: flagBody(opts) })
  }
  return daemonRequest('POST', `/email/${internalId}/flag`, { body: flagBody(opts) })
}

/** D2b — batch resync: enqueue an async_jobs resync job (mirror
 *  HttpApi.email.batchResync — POST /jobs). Returns {job_id, status:'queued',
 *  …} immediately; the serve process JobWorker runs it serially in the
 *  background. `params` stays snake_case (backend
 *  job_runners._resolve_resync_ids reads params.internal_ids); replace_existing
 *  defaults true (live-resync parity with single resync); no idempotencyKey
 *  (every click is a fresh job — re-running the same batch is allowed).
 *  targetKind/targetKey are informational only here — backend batch mode reads
 *  params.internal_ids and only parses target_key for targetKind:'range'. */
export async function runBatchResync(
  internalIds: number[],
  opts: ResyncOpts = {}
): Promise<unknown> {
  return daemonRequest('POST', '/jobs', {
    body: {
      jobType: 'resync',
      targetKind: 'batch',
      targetKey: String(internalIds.length),
      params: {
        internal_ids: internalIds,
        replace_existing: opts.replaceExisting ?? true,
        skip_parent_lookup: opts.skipParentLookup ?? false
      }
    }
  })
}

/** D2b — query async_jobs status / progress / terminal summary (mirror
 *  HttpApi.jobs.get — GET /jobs/{id}). watchResyncJob's polling fallback. */
export async function runGetJob(jobId: number): Promise<unknown> {
  return daemonRequest('GET', `/jobs/${jobId}`)
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
      _opts: unknown = {}
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
      return envelopeFromCli(runPin(idOrErr, pinned))
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

  // Legacy channel (renderer has no live caller; Sprint 15 superseded it with
  // email:flag). 🔴 D1 语义变更: 原 legacy 走 CLI `notion update-flag` 直 PATCH Notion
  // (无 outbox); D1 改转发 outbox flag endpoint (写 SQLite intent + dual-target outbox,
  // FanoutWorker 派发) —— 不同写路径。该 channel 当前无 live caller (HttpApi 侧
  // notImplemented) 故 inert; 若将来重接线须知拿到的是 outbox 语义而非直 PATCH Notion。
  // 旧 dry-run plan 无 consumer; guard 让 stray dryRun 不会静默变真写。
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
      if (o.dryRun) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message:
            'notion:updateFlag dry-run is no longer supported; use email:draftPlan or email:flag'
        }
      }
      return envelopeFromCli(
        runEmailFlag(idOrErr, {
          isRead: o.isRead,
          isFlagged: o.isFlagged,
          processingStatus: o.processingStatus
        })
      )
    }
  )

  // Sprint 15 SSoT inversion. Single row → /email/{id}/flag; batch (opts.ids) →
  // /email/0/flag with body.ids. Both write SQLite intent + dual-target outbox
  // rows in the daemon's service layer; mail-sync's FanoutWorker dispatches.
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

      // Batch mode — bypass ensureInternalId; the server reads body.ids.
      if (Array.isArray(o.ids) && o.ids.length > 0) {
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
      return envelopeFromCli(
        runEmailFlag(idOrErr, {
          isRead: o.isRead,
          isFlagged: o.isFlagged,
          processingStatus: o.processingStatus
        })
      )
    }
  )

  // D2b — batch resync: 选中多封 → enqueue 一个 async_jobs resync job。前置校验
  // internalIds 是非空整数数组 (server 也校验, 这里挡明显错误省一次 daemon RTT)。
  ipcMain.handle(
    'email:batchResync',
    async (_evt, internalIds: unknown, opts: ResyncOpts = {}): Promise<WriteEnvelope<unknown>> => {
      if (!Array.isArray(internalIds) || internalIds.length === 0) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'email:batchResync requires a non-empty internalIds array'
        }
      }
      for (const id of internalIds) {
        if (!Number.isInteger(id) || (id as number) < 0) {
          return {
            ok: false,
            code: 'E_INVALID_ARG',
            message: `email:batchResync: internalIds contains a non-integer id ${String(id)}`
          }
        }
      }
      return envelopeFromCli(runBatchResync(internalIds as number[], opts ?? {}))
    }
  )

  // D2b — async_jobs status query (watchResyncJob polling). jobId is the
  // async_jobs INTEGER PK — same non-negative-integer guard as internal ids.
  ipcMain.handle('jobs:get', async (_evt, jobId: unknown): Promise<WriteEnvelope<unknown>> => {
    const idOrErr = ensureInternalId(jobId, 'jobs:get')
    if (typeof idOrErr !== 'number') return idOrErr
    return envelopeFromCli(runGetJob(idOrErr))
  })
}

// ---- test escape hatch -----------------------------------------------------

export const __testing = {
  flagBody,
  ensureInternalId,
  envelopeFromCli
}
