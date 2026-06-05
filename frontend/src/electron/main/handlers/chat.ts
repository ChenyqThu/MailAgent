// Sprint 4 — chat IPC adapter. Translates renderer requests into
// dispatcher calls; the dispatcher does the actual orchestration.
//
// Channels:
//   chat:start         (invoke) → { sessionId, userMessageId, assistantMessageId } | { error }
//   chat:abort         (send)   — fire-and-forget; renderer doesn't wait
//   chat:listMessages  (invoke) → ChatMessage[]
//   chat:listSessions  (invoke) → ChatSession[]
//   chat:stream        (server-push) — webContents.send'd by the dispatcher
//
// The envelope shape mirrors Sprint 3 translate.ts (REVIEW-LOG codex M-3):
// IPC does not reliably preserve custom Error properties, so we route
// failures through `{ ok: false, code, message }` instead of throwing.

import { BrowserWindow, ipcMain } from 'electron'

import {
  createNewSession,
  deleteSession,
  listAllSessions,
  listMessages,
  listSessionsForEmail,
  listToolCallsForMessage,
  type BackendKind,
  type ChatMessage,
  type ChatSession,
  type ChatSessionSummary,
  type ChatToolCall
} from '../chat_db'
import { getDb } from '../db'
import { saveConversationToKos } from '../chat/kos_save'
import { isKosSaveAvailable } from '../chat/config'
import { createChatDispatcher, type StartChatResult } from '@shared/chat/dispatcher'
import { makeWebContentsSink } from '../chat/web_contents_sink'
import { electronChatPlatform } from '../chat/electron_platform'
import { getChatBackend } from '../chat/registry'
import { drainNotionAgentGate } from '../chat/backends/notion_agent_gate'
import { resolveConfirmation } from '@shared/chat/tools/confirmation'

export interface ChatStartOpts {
  emailId: number
  message: string
  backendKind: BackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
  /** Sprint 19 — explicit target session row. See types.ts ChatStartOpts. */
  sessionId?: number | null
}

// Sprint 14 PR B — payload for inline message edit. Same backend choice
// shape as ChatStartOpts so the IPC layer can keep a single envelope
// type; only the body changes (sessionId + editingMessageId + newContent
// instead of emailId + message).
export interface ChatEditOpts {
  sessionId: number
  editingMessageId: number
  newContent: string
  backendKind: BackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
}

export type ChatStartEnvelope =
  | { ok: true; data: StartChatResult }
  | { ok: false; code: string; message: string }

// Global "AI 会话历史" row — a ChatSessionSummary (from ai_chat.db) enriched
// with the owning email's subject/sender from sync_store.db. Mirror of
// ChatSessionListItem in shared/api/types.ts; kept in sync by hand like the
// other chat IPC shapes (ChatSession / ChatMessage).
export interface ChatSessionListItem extends ChatSessionSummary {
  email_subject: string | null
  email_sender: string | null
}

// V2.1 阶段 3 step 5 — 桌面端 dispatcher 单例。注入 ElectronChatPlatform（基础设施
// 板直调 chat_db/db/config/kos，字节级零回归）+ getChatBackend（注册表）。harness /
// legacy 编排逻辑全在 shared/chat/dispatcher，本进程只提供 platform + backend + sink。
const dispatcher = createChatDispatcher({
  platform: electronChatPlatform,
  getBackend: getChatBackend
})

function validateStartOpts(opts: ChatStartOpts | undefined): ChatStartOpts | string {
  if (!opts) return 'opts missing'
  if (!Number.isInteger(opts.emailId) || opts.emailId < 0)
    return 'emailId must be a non-negative integer'
  if (typeof opts.message !== 'string' || opts.message.length === 0)
    return 'message must be a non-empty string'
  if (opts.backendKind !== 'notion-agent' && opts.backendKind !== 'custom-api')
    return `backendKind must be 'notion-agent' or 'custom-api', got ${opts.backendKind}`
  return opts
}

export function registerChatHandlers(): void {
  ipcMain.handle('chat:start', async (evt, opts: ChatStartOpts): Promise<ChatStartEnvelope> => {
    const valid = validateStartOpts(opts)
    if (typeof valid === 'string') {
      return { ok: false, code: 'E_INVALID_ARG', message: valid }
    }
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) {
      return { ok: false, code: 'E_NO_WINDOW', message: 'chat:start fired without a BrowserWindow' }
    }
    try {
      const sink = makeWebContentsSink(evt.sender)
      const data = await dispatcher.startChat(
        {
          emailId: valid.emailId,
          userMessage: valid.message,
          backendKind: valid.backendKind,
          backendModel: valid.backendModel ?? null,
          backendAgentPageId: valid.backendAgentPageId ?? null,
          sessionId: valid.sessionId ?? null
        },
        sink
      )
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('No chat backend registered')
        ? 'E_BACKEND_UNAVAILABLE'
        : 'E_DISPATCH'
      return { ok: false, code, message }
    }
  })

  ipcMain.on('chat:abort', (_evt, sessionId: number) => {
    if (Number.isInteger(sessionId) && sessionId >= 0) {
      // abortChatSession 现 async（abortStreamingMessages 走 platform Promise）；
      // chat:abort 是 fire-and-forget send channel，不 await 返回的 promise。
      void dispatcher.abortChatSession(sessionId)
    }
  })

  // Sprint 19 PR-1d.1 — Confirmation reply from ConfirmToolDialog. The
  // renderer fires this when the user clicks Confirm or Cancel; the
  // harness has a promise registered in tools/confirmation.ts waiting
  // for the answer. `editedInput` is only present for tier=edit dialogs
  // where the user modified the LLM's proposal before approving.
  // Returns ok:false on late arrival (session already aborted, dialog
  // dismissed externally, etc.) so the renderer can show a "no longer
  // pending" toast rather than silently dropping the click.
  ipcMain.handle(
    'chat:confirmTool',
    async (
      _evt,
      payload: { toolUseId?: unknown; approved?: unknown; editedInput?: unknown }
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
      const toolUseId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : ''
      const approved = payload?.approved === true
      if (toolUseId.length === 0) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'toolUseId required' }
      }
      const accepted = resolveConfirmation(toolUseId, {
        approved,
        editedInput: approved ? payload?.editedInput : undefined
      })
      if (!accepted) {
        return {
          ok: false,
          code: 'E_NOT_PENDING',
          message: `no confirmation pending for toolUseId="${toolUseId}"`
        }
      }
      return { ok: true }
    }
  )

  ipcMain.handle('chat:listMessages', async (_evt, sessionId: number): Promise<ChatMessage[]> => {
    if (!Number.isInteger(sessionId) || sessionId < 0) return []
    return listMessages(sessionId)
  })

  ipcMain.handle('chat:listSessions', async (_evt, emailId: number): Promise<ChatSession[]> => {
    if (!Number.isInteger(emailId) || emailId < 0) return []
    return listSessionsForEmail(emailId)
  })

  // Global session history (cross-email) for the "AI 会话历史" page. Two
  // databases are involved: ai_chat.db owns the sessions + message preview,
  // sync_store.db owns the email subject/sender. We batch-join the email meta
  // in one IN-query keyed by the distinct email_ids, falling back to nulls if
  // sync_store.db is unavailable (fresh install, FDA not granted) so the page
  // still renders the conversations with their message previews.
  ipcMain.handle('chat:listAllSessions', async (): Promise<ChatSessionListItem[]> => {
    const summaries = listAllSessions()
    const meta = new Map<number, { subject: string | null; sender: string | null }>()
    try {
      const ids = [...new Set(summaries.map((s) => s.email_id))]
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        const rows = getDb()
          .prepare(
            `SELECT internal_id, subject, sender_name, sender
               FROM email_metadata WHERE internal_id IN (${placeholders})`
          )
          .all(...ids) as Array<{
          internal_id: number
          subject: string | null
          sender_name: string | null
          sender: string | null
        }>
        for (const r of rows) {
          meta.set(r.internal_id, { subject: r.subject, sender: r.sender_name ?? r.sender })
        }
      }
    } catch {
      // sync_store.db missing/locked → degrade to preview-only rows.
    }
    return summaries.map((s) => ({
      ...s,
      email_subject: meta.get(s.email_id)?.subject ?? null,
      email_sender: meta.get(s.email_id)?.sender ?? null
    }))
  })

  // Sprint 14 PR J — sidebar trash icon → user-confirmed delete.
  // CASCADE FK on ai_chat_messages drops the message rows automatically;
  // any in-flight stream on that session was already aborted by the
  // renderer (useEmailChat.deleteSession calls chat.abort first). Bad
  // sessionId silently no-ops because Number.isInteger gate above keeps
  // garbage from the SQLite layer.
  ipcMain.on('chat:deleteSession', (_evt, sessionId: number) => {
    if (!Number.isInteger(sessionId) || sessionId < 0) return
    deleteSession(sessionId)
  })

  // Sprint 19 — explicit "+ 新建会话" intent from renderer. INSERT a
  // fresh ai_chat_sessions row (v4 schema dropped UNIQUE on email +
  // backend + agent_page_id so reuse-bypass is just an unconditional
  // INSERT). Returns the new row; useEmailChat threads sessionId into
  // the next chat:start so the user's message lands here, not on a
  // resurrected legacy session via getOrCreateSession.
  ipcMain.handle(
    'chat:newSession',
    async (
      _evt,
      input: {
        emailId?: unknown
        backendKind?: unknown
        backendModel?: unknown
        backendAgentPageId?: unknown
      }
    ): Promise<{ ok: true; data: ChatSession } | { ok: false; code: string; message: string }> => {
      if (!input || typeof input !== 'object') {
        return { ok: false, code: 'E_INVALID_ARG', message: 'newSession input required' }
      }
      if (!Number.isInteger(input.emailId) || (input.emailId as number) < 0) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'emailId must be a non-negative integer'
        }
      }
      if (input.backendKind !== 'notion-agent' && input.backendKind !== 'custom-api') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: `backendKind must be 'notion-agent' or 'custom-api', got ${String(input.backendKind)}`
        }
      }
      try {
        const data = createNewSession({
          emailId: input.emailId as number,
          backendKind: input.backendKind as BackendKind,
          backendModel: typeof input.backendModel === 'string' ? input.backendModel : null,
          backendAgentPageId:
            typeof input.backendAgentPageId === 'string' ? input.backendAgentPageId : null
        })
        return { ok: true, data }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code: 'E_DISPATCH', message }
      }
    }
  )

  // Sprint 14 PR B — chat:editMessage. Same envelope shape as chat:start
  // (renderer awaits ok=true|false), since both ultimately wrap a
  // dispatcher promise + spawn a background runStream consumer.
  ipcMain.handle(
    'chat:editMessage',
    async (evt, opts: ChatEditOpts): Promise<ChatStartEnvelope> => {
      const valid = validateEditOpts(opts)
      if (typeof valid === 'string') {
        return { ok: false, code: 'E_INVALID_ARG', message: valid }
      }
      const win = BrowserWindow.fromWebContents(evt.sender)
      if (!win) {
        return {
          ok: false,
          code: 'E_NO_WINDOW',
          message: 'chat:editMessage fired without a BrowserWindow'
        }
      }
      try {
        const sink = makeWebContentsSink(evt.sender)
        const data = await dispatcher.editChatMessage(
          {
            sessionId: valid.sessionId,
            editingMessageId: valid.editingMessageId,
            newContent: valid.newContent,
            backendKind: valid.backendKind,
            backendModel: valid.backendModel ?? null,
            backendAgentPageId: valid.backendAgentPageId ?? null
          },
          sink
        )
        return { ok: true, data }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const codeAttr =
          err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string'
            ? (err as Error & { code: string }).code
            : null
        const code =
          codeAttr ??
          (message.includes('No chat backend registered') ? 'E_BACKEND_UNAVAILABLE' : 'E_DISPATCH')
        return { ok: false, code, message }
      }
    }
  )

  // Sprint 19 P1-C — chat:saveToKos. Renderer's [✨ 保存到 KOS] button
  // invokes this with { messageId, slug?, title? }. Service in
  // chat/kos_save.ts loads the assistant message + preceding user
  // message, builds markdown page with frontmatter, KOSClient.putPage.
  // Same { ok, data | code+message } envelope shape as chat:start.
  ipcMain.handle(
    'chat:saveToKos',
    async (
      _evt,
      input: { messageId?: unknown; slug?: unknown; title?: unknown }
    ): Promise<
      | { ok: true; data: { slug: string; status: string; contentBytes: number } }
      | { ok: false; code: string; message: string }
    > => {
      if (!input || typeof input !== 'object') {
        return { ok: false, code: 'E_INVALID_ARG', message: 'saveToKos input required' }
      }
      if (!Number.isInteger(input.messageId) || (input.messageId as number) < 0) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'messageId must be a non-negative integer'
        }
      }
      try {
        const data = await saveConversationToKos({
          messageId: input.messageId as number,
          slug: typeof input.slug === 'string' && input.slug.length > 0 ? input.slug : undefined,
          title: typeof input.title === 'string' && input.title.length > 0 ? input.title : undefined
        })
        return { ok: true, data }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code =
          err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string'
            ? (err as Error & { code: string }).code
            : 'E_DISPATCH'
        return { ok: false, code, message }
      }
    }
  )

  // Sprint 19 P1-C — chat:kosAvailable. Renderer's AssistantMessageFooter
  // queries this once on mount to decide whether to render the [✨ 保存到 KOS]
  // button. True only when KOS OAuth credentials are configured (mirrors
  // KOSClient.configured); the renderer can't read process.env so this is
  // the env→renderer bridge. Cheap pure env check — no IPC envelope needed.
  ipcMain.handle('chat:kosAvailable', async (): Promise<boolean> => {
    return isKosSaveAvailable()
  })

  // Sprint 19 §D #3 — chat:listToolCalls. Renderer ToolCallRow fetches
  // audit rows per assistant message to render the tool I/O folding card.
  // Backed by `listToolCallsForMessage` in chat_db.ts; messageId of an
  // assistant turn that had no tool_use returns []. Bad input rejected
  // defensively (renderer always passes integer from message.id).
  ipcMain.handle('chat:listToolCalls', async (_evt, messageId: number): Promise<ChatToolCall[]> => {
    if (!Number.isInteger(messageId) || messageId < 0) return []
    return listToolCallsForMessage(messageId)
  })
}

function validateEditOpts(opts: ChatEditOpts | undefined): ChatEditOpts | string {
  if (!opts) return 'opts missing'
  if (!Number.isInteger(opts.sessionId) || opts.sessionId < 0)
    return 'sessionId must be a non-negative integer'
  if (!Number.isInteger(opts.editingMessageId) || opts.editingMessageId < 0)
    return 'editingMessageId must be a non-negative integer'
  if (typeof opts.newContent !== 'string' || opts.newContent.length === 0)
    return 'newContent must be a non-empty string'
  if (opts.backendKind !== 'notion-agent' && opts.backendKind !== 'custom-api')
    return `backendKind must be 'notion-agent' or 'custom-api', got ${opts.backendKind}`
  return opts
}

// App-quit hook（index.ts:15/465 仍 import 此名，路径/签名不变）。shared dispatcher
// 只 abort+clear _inflight；drainNotionAgentGate（main-only 子进程串行闸的 min-interval
// 定时器，不挂任何 signal）在此补齐 —— 不能进 shared（无 Electron/Node）。
export function abortAllChatSessions(): void {
  dispatcher.abortAllChatSessions()
  drainNotionAgentGate()
}
