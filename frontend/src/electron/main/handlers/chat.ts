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
  listMessages,
  listSessionsForEmail,
  type BackendKind,
  type ChatMessage,
  type ChatSession
} from '../chat_db'
import { saveConversationToKos } from '../chat/kos_save'
import {
  abortAllChatSessions,
  abortChatSession,
  editChatMessage,
  makeWebContentsSink,
  startChat,
  type StartChatResult
} from '../chat/dispatcher'
import { resolveConfirmation } from '../chat/tools/confirmation'

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
      const data = await startChat(
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
      abortChatSession(sessionId)
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
    ): Promise<
      { ok: true; data: ChatSession } | { ok: false; code: string; message: string }
    > => {
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
        const data = await editChatMessage(
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
          title:
            typeof input.title === 'string' && input.title.length > 0 ? input.title : undefined
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

export { abortAllChatSessions }
