// Sprint 19 PR-1d.1 — Email write tools.
//
// Three tools that mutate state: email_flag / email_archive / email_draft_reply.
// All require user confirmation via ConfirmToolDialog before executing —
// flag/archive are tier=preview (reversible inside SQLite + outbox), draft
// is tier=edit (the user might edit the body before Mail.app actually
// creates the draft). The actual confirmation dance lives in dispatch.ts;
// these handlers just do the write once dispatch invokes them.
//
// Surface choices (per Plan D6, D1 收编):
//   - email_flag / email_archive  → daemon flag (runEmailFlag → 本机 serve-api
//     POST /email/{id}/flag, in-process outbox SSoT 写; D1 起不再 IPC 直写
//     SQLite, 写源统一 daemon service)
//   - email_draft_reply           → IPC createDraft (AppleScript via shell
//     script, ~3-5s, returns Mail.app draft_id; host-local, 保留 emergency 直 fork)

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import { runEmailFlag } from '../../../handlers/write_ops'
import { createDraft as ipcCreateDraft } from '../../../handlers/draft'

/** daemon flag 返回的 FlagResult data 块的相关字段 (替代旧 IPC 直写路径的
 *  {outbox_ids,merged_ids} —— D1 parity 调查确认的唯一形状变更点)。 */
interface FlagData {
  updated_ids?: number[]
  outbox_entries?: unknown[]
}

// ── helpers ────────────────────────────────────────────────────────────

function asInt(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x)) return x
  return null
}

function asBool(x: unknown): boolean | undefined {
  return typeof x === 'boolean' ? x : undefined
}

function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}

function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}

/** Resolve the effective input for a write tool — when the user edited the
 *  proposal in the ConfirmToolDialog, the dispatch layer stuffs the edited
 *  payload into `ctx.userEditedInput`. The tool handler uses that, NOT the
 *  original LLM-proposed input. Returns both shapes so the tool can also
 *  surface "user changed X to Y" detail in the result envelope. */
function effective(
  input: unknown,
  ctx: ToolExecCtx
): {
  resolved: unknown
  userEdited: boolean
} {
  if (ctx.userEditedInput !== undefined) {
    return { resolved: ctx.userEditedInput, userEdited: true }
  }
  return { resolved: input, userEdited: false }
}

// ── 1. email_flag — toggle isRead / isFlagged / processingStatus ─────────

export const emailFlag: ToolDef = {
  name: 'email_flag',
  description:
    'Toggle is_read / is_flagged / processing_status on a single email by internal_id. ' +
    'Writes through the Sprint 16 outbox SSoT (~5ms): updates email_metadata + enqueues ' +
    'mailapp + notion outbox rows for fanout. Reversible — call again with inverse values to undo. ' +
    'Requires user confirmation (preview tier).',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer' },
      is_read: { type: 'boolean', description: 'Set the read flag.' },
      is_flagged: { type: 'boolean', description: 'Set the flag (旗标) state.' },
      processing_status: {
        type: 'string',
        description:
          'Notion-only processing status (e.g. "已完成"). Mail.app has no equivalent — ' +
          'only the notion outbox row gets a payload for this field.'
      }
    },
    required: ['internal_id']
  },
  confirmationTier: 'preview',
  category: 'write',
  surface: 'ipc',
  timeoutMs: 5000,
  throttlePerMinute: 6,
  handler: async (input, ctx): Promise<ToolResult> => {
    const start = Date.now()
    const { resolved, userEdited } = effective(input, ctx)
    const i = (resolved ?? {}) as Record<string, unknown>
    const id = asInt(i.internal_id)
    if (id === null || id < 0) {
      return err('E_INVALID_ARG', 'internal_id required (non-negative integer)', start)
    }
    const isRead = asBool(i.is_read)
    const isFlagged = asBool(i.is_flagged)
    const processingStatus = asStr(i.processing_status)
    if (isRead === undefined && isFlagged === undefined && processingStatus === undefined) {
      return err(
        'E_INVALID_ARG',
        'at least one of is_read / is_flagged / processing_status must be set',
        start
      )
    }
    try {
      const data = (await runEmailFlag(id, { isRead, isFlagged, processingStatus })) as FlagData
      return ok(
        {
          internal_id: id,
          applied: { is_read: isRead, is_flagged: isFlagged, processing_status: processingStatus },
          updated_ids: data.updated_ids ?? [],
          outbox_entries: data.outbox_entries ?? [],
          user_edited: userEdited
        },
        start
      )
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'E_INTERNAL'
      return err(code, e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 2. email_archive — convenience wrapper: set processing_status='已完成' ─

export const emailArchive: ToolDef = {
  name: 'email_archive',
  description:
    'Mark an email as completed (sets processing_status="已完成"). The Notion outbox ' +
    'fanout flips the Mail.app flag off so the email exits the inbox view. Use when ' +
    'the user has finished dealing with an email. Preview tier — reversible by re-flagging. ' +
    'NOT a destructive delete — the email row stays in the local DB and Notion.',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer' }
    },
    required: ['internal_id']
  },
  confirmationTier: 'preview',
  category: 'write',
  surface: 'ipc',
  timeoutMs: 5000,
  throttlePerMinute: 6,
  handler: async (input, ctx): Promise<ToolResult> => {
    const start = Date.now()
    const { resolved, userEdited } = effective(input, ctx)
    const i = (resolved ?? {}) as Record<string, unknown>
    const id = asInt(i.internal_id)
    if (id === null || id < 0) {
      return err('E_INVALID_ARG', 'internal_id required (non-negative integer)', start)
    }
    try {
      const data = (await runEmailFlag(id, { processingStatus: '已完成' })) as FlagData
      return ok(
        {
          internal_id: id,
          archived: true,
          updated_ids: data.updated_ids ?? [],
          outbox_entries: data.outbox_entries ?? [],
          user_edited: userEdited
        },
        start
      )
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'E_INTERNAL'
      return err(code, e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 3. email_draft_reply — create reply draft in Mail.app ────────────────

export const emailDraftReply: ToolDef = {
  name: 'email_draft_reply',
  description:
    'Compose a reply draft in Mail.app for the given email. The user will see your proposed ' +
    'body in a confirmation dialog and CAN edit it before the draft is created. After confirmation, ' +
    'a real draft message appears in Mail.app (not auto-sent — the user still has to click Send). ' +
    'Body should be markdown (bold, italics, lists, links supported). Edit tier — the user ' +
    'may modify your draft.',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer', description: 'The email being replied to.' },
      body_markdown: {
        type: 'string',
        minLength: 1,
        description:
          'Reply body in markdown. Will be inserted into the standard reply-all draft on top of ' +
          'the quoted source. Keep concise; the user reviews before sending.'
      }
    },
    required: ['internal_id', 'body_markdown']
  },
  confirmationTier: 'edit',
  category: 'write',
  surface: 'ipc',
  timeoutMs: 30_000, // AppleScript + Mail.app can be slow on first launch
  throttlePerMinute: 4,
  handler: async (input, ctx): Promise<ToolResult> => {
    const start = Date.now()
    const { resolved, userEdited } = effective(input, ctx)
    const i = (resolved ?? {}) as Record<string, unknown>
    const id = asInt(i.internal_id)
    if (id === null || id < 0) {
      return err('E_INVALID_ARG', 'internal_id required (non-negative integer)', start)
    }
    const body = asStr(i.body_markdown)
    if (!body) {
      return err('E_INVALID_ARG', 'body_markdown required (non-empty string)', start)
    }
    try {
      const data = await ipcCreateDraft({ internalId: id, body })
      return ok(
        {
          internal_id: data.internalId,
          mailbox: data.mailbox,
          account_name: data.accountName,
          draft_id: data.draftId,
          user_edited: userEdited,
          // Include the final body so the LLM next-turn knows EXACTLY what
          // landed in Mail.app (relevant when user edited via the dialog).
          final_body_markdown: body
        },
        start
      )
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? 'E_INTERNAL'
      const message = e instanceof Error ? e.message : String(e)
      return err(code, message, start)
    }
  }
}

export const allWriteTools: ToolDef[] = [emailFlag, emailArchive, emailDraftReply]
