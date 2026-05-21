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
  listMessages,
  listSessionsForEmail,
  type BackendKind,
  type ChatMessage,
  type ChatSession
} from '../chat_db'
import {
  abortAllChatSessions,
  abortChatSession,
  editChatMessage,
  makeWebContentsSink,
  startChat,
  type StartChatResult
} from '../chat/dispatcher'

export interface ChatStartOpts {
  emailId: number
  message: string
  backendKind: BackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
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
          backendAgentPageId: valid.backendAgentPageId ?? null
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

  ipcMain.handle('chat:listMessages', async (_evt, sessionId: number): Promise<ChatMessage[]> => {
    if (!Number.isInteger(sessionId) || sessionId < 0) return []
    return listMessages(sessionId)
  })

  ipcMain.handle('chat:listSessions', async (_evt, emailId: number): Promise<ChatSession[]> => {
    if (!Number.isInteger(emailId) || emailId < 0) return []
    return listSessionsForEmail(emailId)
  })

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
