// V2.1 阶段 3 — 3b-4：Email write tools（从 electron `chat/tools/builtin/write.ts` 下沉 shared）。
//
// Eight tools that mutate state: email_flag / email_archive / email_draft_reply /
// email_set_reply_suggestion / email_set_ai_fields / email_pin / email_move / email_resync.
// All require user confirmation via ConfirmToolDialog before executing —
// flag/archive/pin/move/resync are tier=preview (reversible), draft + set_reply_suggestion +
// set_ai_fields are tier=edit (the user might edit the proposed text/values before it is
// written). The confirmation dance lives in dispatch.ts; these handlers just do the write
// once dispatch invokes them.
//
// 后端原语经注入的 ChatToolPlatform：
//   - email_flag / email_archive  → platform.flagEmail（electron+http 都→本机 serve-api
//     POST /email/{id}/flag, in-process outbox SSoT 写; D1 起写源统一 daemon service，零 parity）
//   - email_draft_reply           → platform.draftReply（POST /email/draft: bodyText +
//     quoteOriginal、不传 to/cc → 服务端推导 reply-all 收件人 + 拼引用原文, davmail IMAP
//     APPEND; electron renderer / 远程 browser 都经 HttpChatPlatform, 不再走 AppleScript）

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import type { ChatToolPlatform } from '../../platform'

/** platform.flagEmail 返回的 daemon FlagResult data 块的相关字段（替代旧 IPC 直写路径的
 *  {outbox_ids,merged_ids} —— D1 parity 调查确认的唯一形状变更点）。 */
interface FlagData {
  updated_ids?: number[]
  outbox_entries?: unknown[]
}

/** platform.archiveEmail / moveEmail 返回的 MailWriteService ArchiveResult/MoveResult data 块。 */
interface ArchiveData {
  from_mailbox?: string | null
  to_mailbox?: string | null
  notion_updated?: boolean
}

/** platform.setPin 返回的 MailWriteService PinResult data 块。 */
interface PinData {
  is_pinned?: boolean
  changed?: boolean
}

/** platform.resyncEmail 返回的 MailWriteService ResyncResult data 块。 */
interface ResyncData {
  old_page_id?: string | null
  new_page_id?: string | null
  action?: string
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

/** Build the 8 write tools bound to the injected platform. */
export function createWriteTools(platform: ChatToolPlatform): ToolDef[] {
  // ── 1. email_flag — toggle isRead / isFlagged / processingStatus ─────────
  const emailFlag: ToolDef = {
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
        const data = (await platform.flagEmail(id, {
          isRead,
          isFlagged,
          processingStatus
        })) as FlagData
        return ok(
          {
            internal_id: id,
            applied: {
              is_read: isRead,
              is_flagged: isFlagged,
              processing_status: processingStatus
            },
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

  // ── 2. email_archive — move the email out of the inbox into Archive ──────
  const emailArchive: ToolDef = {
    name: 'email_archive',
    description:
      'Archive an email: move it (IMAP MOVE) into the Archive folder and set its mailbox to ' +
      '"存档" so it leaves the inbox view (and the Notion mirror updates). Use when the user has ' +
      'finished with an email and wants it out of the inbox. Preview tier — reversible (move it ' +
      'back or re-sync). NOT a destructive delete — the message and its body/attachments are ' +
      'kept. davmail-only: on the AppleScript backend this returns an error.',
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
    // IMAP MOVE round-trip (davmail) — wider budget than a pure SQLite flag.
    timeoutMs: 15_000,
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
        // Real archive (IMAP move→Archive + Mailbox→存档 + Notion mirror), not just a
        // processing_status flag — matches the inbox "Archive" button (service.archive).
        const data = (await platform.archiveEmail(id)) as ArchiveData
        return ok(
          {
            internal_id: id,
            archived: true,
            from_mailbox: data.from_mailbox ?? null,
            to_mailbox: data.to_mailbox ?? '存档',
            notion_updated: data.notion_updated ?? false,
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

  // ── 3. email_draft_reply — create reply draft in the Drafts folder ───────
  const emailDraftReply: ToolDef = {
    name: 'email_draft_reply',
    description:
      'Compose a reply-all draft for the given email. The user will see your proposed ' +
      'body in a confirmation dialog and CAN edit it before the draft is created. After confirmation, ' +
      'a real draft message is saved to the Drafts folder (not auto-sent — the user still has to click ' +
      'Send); the original message is quoted below your body and recipients are derived for reply-all. ' +
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
    // draftReply → POST /email/draft (davmail IMAP APPEND) — no longer the slow
    // AppleScript + Mail.app GUI path; 15s comfortably covers an IMAP round-trip.
    timeoutMs: 15_000,
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
        const data = await platform.draftReply(id, body)
        return ok(
          {
            internal_id: data.internalId,
            mailbox: data.mailbox,
            account_name: data.accountName,
            draft_id: data.draftId,
            user_edited: userEdited,
            // Include the final body so the LLM next-turn knows EXACTLY what
            // landed in the draft / Drafts folder (relevant when user edited via the dialog).
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

  // ── 4. email_set_reply_suggestion — write the AI reply-suggestion field ──
  const emailSetReplySuggestion: ToolDef = {
    name: 'email_set_reply_suggestion',
    description:
      'Save / overwrite the AI reply-suggestion (建议回复) for an email. Writes markdown to the ' +
      'SQLite source-of-truth that the email detail view renders and that the reply / Craft compose ' +
      'flow prefills from — so after this, opening "Reply" on the email starts with your text. This ' +
      'does NOT create or send a draft (use email_draft_reply for that); it only stores the suggested ' +
      'reply text. The user sees and CAN edit your markdown in a confirmation dialog before it is saved ' +
      '(edit tier). Body should be concise markdown (inline elements + lists).',
    inputSchema: {
      type: 'object',
      properties: {
        internal_id: { type: 'integer', description: 'The email to set the reply suggestion for.' },
        reply_suggestion_md: {
          type: 'string',
          minLength: 1,
          description:
            'The suggested reply, in markdown. Replaces any existing suggestion. Keep it concise; the ' +
            'user reviews/edits before it is saved and again before any draft is created from it.'
        }
      },
      required: ['internal_id', 'reply_suggestion_md']
    },
    confirmationTier: 'edit',
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
      const md = asStr(i.reply_suggestion_md)
      if (!md) {
        return err('E_INVALID_ARG', 'reply_suggestion_md required (non-empty string)', start)
      }
      try {
        const data = await platform.setReplySuggestion(id, md)
        return ok(
          {
            internal_id: data.internalId,
            reply_suggestion_md: data.replySuggestionMd,
            chars: data.chars,
            user_edited: userEdited
          },
          start
        )
      } catch (e) {
        const code = (e as Error & { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 4b. email_set_ai_fields — overwrite the AI classification fields ─────
  // Legal enum values are taken verbatim from src/llm_agent/schema.py (PRIORITY_ENUM
  // + ACTION_TYPE_INBOX/SENT). serve-api (MailWriteService.set_ai_fields) is the
  // authoritative validator — it rejects invalid values AND enforces the mailbox-specific
  // action subset (inbox vs sent). The schema enums here are the union, so the LLM only
  // proposes legal-shaped values; a sent-only action on an inbox email still gets rejected
  // server-side (the tool surfaces that error).
  const emailSetAiFields: ToolDef = {
    name: 'email_set_ai_fields',
    description:
      "Overwrite an email's AI classification — AI Action (建议动作), AI Priority (优先级), " +
      'and/or AI Review Status — in the SQLite source-of-truth the inbox list & detail view ' +
      'render from. This REPLACES the LLM-assigned classification for the fields you provide ' +
      '(other AI fields like the summary are untouched). At least one of ai_action / ai_priority ' +
      '/ ai_review_status is required. The user sees and CAN edit your proposed values in a ' +
      'confirmation dialog before they are written (edit tier). Use when the user disagrees with ' +
      'the auto-classification, e.g. "mark this as urgent" or "this needs a reply". Note: ai_action ' +
      'must match the mailbox (inbox vs sent use different value sets); an invalid value is rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        internal_id: { type: 'integer', description: 'The email to reclassify.' },
        ai_action: {
          type: 'string',
          // Union of ACTION_TYPE_INBOX + ACTION_TYPE_SENT (schema.py). serve-api enforces
          // the mailbox-specific subset.
          enum: [
            '需要回复',
            '需要决策',
            '需要Review',
            '需要会议',
            '仅供参考',
            '等待响应',
            '需要跟进',
            '已完结'
          ],
          description:
            'AI Action. Inbox emails: 需要回复 / 需要决策 / 需要Review / 需要会议 / 仅供参考. ' +
            'Sent emails: 等待响应 / 需要跟进 / 已完结 / 仅供参考. Must match the email mailbox.'
        },
        ai_priority: {
          type: 'string',
          enum: ['🔴 紧急', '🟡 重要', '🟢 一般', '⚪ 低'],
          description:
            'AI Priority. 🔴 紧急 = production incident / release blocker needing immediate action; ' +
            '🟡 重要 = key review / deadline; 🟢 一般 = routine; ⚪ 低 = FYI.'
        },
        ai_review_status: {
          type: 'string',
          enum: ['reviewed', 'pending'],
          description:
            'AI Review Status. "reviewed" = classification confirmed/done; "pending" = still needs review.'
        }
      },
      required: ['internal_id']
    },
    confirmationTier: 'edit',
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
      const aiAction = asStr(i.ai_action)
      const aiPriority = asStr(i.ai_priority)
      const aiReviewStatus = asStr(i.ai_review_status)
      if (aiAction === undefined && aiPriority === undefined && aiReviewStatus === undefined) {
        return err(
          'E_INVALID_ARG',
          'at least one of ai_action / ai_priority / ai_review_status must be set',
          start
        )
      }
      try {
        const data = await platform.setAiFields(id, { aiAction, aiPriority, aiReviewStatus })
        return ok(
          {
            internal_id: data.internalId,
            ai_action: data.aiAction,
            ai_priority: data.aiPriority,
            ai_review_status: data.aiReviewStatus,
            user_edited: userEdited
          },
          start
        )
      } catch (e) {
        const code = (e as Error & { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 5. email_pin — pin / unpin an email to the top of the list ───────────
  const emailPin: ToolDef = {
    name: 'email_pin',
    description:
      'Pin or unpin an email so it stays at the top of the list (pinned=true to pin, false to ' +
      'unpin). This is a local UI flag only — it does not touch Mail.app / Notion and is fully ' +
      'reversible. Use when the user wants to keep an email handy / stop pinning it. Preview tier.',
    inputSchema: {
      type: 'object',
      properties: {
        internal_id: { type: 'integer' },
        pinned: { type: 'boolean', description: 'true = pin, false = unpin.' }
      },
      required: ['internal_id', 'pinned']
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
      const pinned = asBool(i.pinned)
      if (pinned === undefined) {
        return err('E_INVALID_ARG', 'pinned (boolean) required', start)
      }
      try {
        const data = (await platform.setPin(id, pinned)) as PinData
        return ok(
          {
            internal_id: id,
            is_pinned: data.is_pinned ?? pinned,
            changed: data.changed ?? false,
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

  // ── 6. email_move — move an email to another folder (davmail IMAP MOVE) ──
  const emailMove: ToolDef = {
    name: 'email_move',
    description:
      'Move an email to another folder by IMAP MOVE (updates the local mailbox + Notion mirror). ' +
      'dst_imap_name is the raw IMAP folder name. Refuses moves into Trash/Junk (that is a delete, ' +
      'not a move). Use when the user asks to file an email into a specific folder. davmail-only. ' +
      'Preview tier — reversible by moving back.',
    inputSchema: {
      type: 'object',
      properties: {
        internal_id: { type: 'integer' },
        dst_imap_name: {
          type: 'string',
          minLength: 1,
          description:
            'Destination IMAP folder name (raw, e.g. "Archive" or a custom folder). Not a display label.'
        }
      },
      required: ['internal_id', 'dst_imap_name']
    },
    confirmationTier: 'preview',
    category: 'write',
    surface: 'ipc',
    timeoutMs: 15_000,
    throttlePerMinute: 6,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const { resolved, userEdited } = effective(input, ctx)
      const i = (resolved ?? {}) as Record<string, unknown>
      const id = asInt(i.internal_id)
      if (id === null || id < 0) {
        return err('E_INVALID_ARG', 'internal_id required (non-negative integer)', start)
      }
      const dst = asStr(i.dst_imap_name)
      if (!dst) {
        return err('E_INVALID_ARG', 'dst_imap_name required (non-empty string)', start)
      }
      try {
        const data = (await platform.moveEmail(id, dst)) as ArchiveData
        return ok(
          {
            internal_id: id,
            moved: true,
            from_mailbox: data.from_mailbox ?? null,
            to_mailbox: data.to_mailbox ?? null,
            notion_updated: data.notion_updated ?? false,
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

  // ── 7. email_resync — re-push an email to Notion ─────────────────────────
  const emailResync: ToolDef = {
    name: 'email_resync',
    description:
      'Re-push an email to Notion from the local SQLite source-of-truth (recreates / refreshes its ' +
      "Notion page). Use when an email's Notion page is missing, stale, or out of sync. Preview " +
      'tier. Idempotent — safe to run again. Returns the old/new Notion page id + action taken.',
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
    timeoutMs: 30_000,
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
        const data = (await platform.resyncEmail(id)) as ResyncData
        return ok(
          {
            internal_id: id,
            old_page_id: data.old_page_id ?? null,
            new_page_id: data.new_page_id ?? null,
            action: data.action ?? 'unknown',
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

  return [
    emailFlag,
    emailArchive,
    emailDraftReply,
    emailSetReplySuggestion,
    emailSetAiFields,
    emailPin,
    emailMove,
    emailResync
  ]
}
