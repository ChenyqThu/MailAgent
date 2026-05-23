// Sprint 4 — chat orchestrator. Owns:
//   - per-session AbortController (so renderer cancel works no matter which
//     backend is mid-stream)
//   - DB writes (every backend event is durable; reload restores the
//     conversation up to wherever the abort/error landed)
//   - IPC fanout (every event the backend yields gets wrapped in a
//     `ChatStreamEnvelope` and fired to the requesting webContents)
//
// Why the dispatch loop is here and not in handlers/chat.ts: the loop has
// no IPC opinions of its own — it just consumes the backend's iterator
// and persists/forwards each event. handlers/chat.ts is the IPC adapter
// (request → dispatch start, abort signal → cancel). Keeping the two
// layers separate makes the dispatcher testable without mocking ipcMain.

import type { WebContents } from 'electron'

import {
  abortStreamingMessages,
  appendMessage,
  deleteMessagesFromId,
  getMessage,
  getOrCreateSession,
  getSession,
  listMessages,
  updateMessage,
  type BackendKind,
  type ChatMessage
} from '../chat_db'
import { getDb } from '../db'
import { backendSupportsTools, isHarnessEnabled } from './config'
import { runHarness } from './harness'
import { getChatBackend } from './registry'
import { cancelConfirmationsForSession } from './tools/confirmation'
import type { ChatStreamEnvelope, ChatStreamEvent, EmailContext } from './types'

// Sprint 4 review (Opus H-1): cap the email body we ship to the model so
// a giant marketing email doesn't blow the context window. Matches the
// Sprint 3 translate.ts limit + backend LLM_BODY_MAX_CHARS.
const MAX_BODY_CHARS = 12_000

/** Pull the active email's metadata + markdown body from the SQLite SSoT
 *  so the backend's system prompt can actually include the email content.
 *  Returns null when the row is missing or the DB is unreachable (chat
 *  still works, the model just won't see the email). */
function loadEmailContext(emailId: number): EmailContext | null {
  try {
    const db = getDb()
    // PR-2g dogfood fix: 加 ai_priority / ai_action / processing_status 进
    // ctx, 让 chat agent system prompt 看到 'AI 已标 🟡 重要 + 需要决策'
    // 直接判断, 不必先 query 一轮. 字段从 email_metadata v14 主表读
    // (LLM agent processor.py write 进主表 + labels_json sidecar).
    const row = db
      .prepare(
        `SELECT m.internal_id, m.subject, m.sender_name, m.sender, m.date_received,
                m.notion_page_id, m.ai_priority, m.ai_action, m.processing_status,
                b.body_markdown
           FROM email_metadata m
           LEFT JOIN email_body b ON b.internal_id = m.internal_id
          WHERE m.internal_id = ?`
      )
      .get(emailId) as
      | {
          internal_id: number
          subject: string | null
          sender_name: string | null
          sender: string | null
          date_received: string | null
          notion_page_id: string | null
          ai_priority: string | null
          ai_action: string | null
          processing_status: string | null
          body_markdown: string | null
        }
      | undefined
    if (!row) return null
    const body =
      typeof row.body_markdown === 'string' ? row.body_markdown.slice(0, MAX_BODY_CHARS) : null
    return {
      internalId: row.internal_id,
      subject: row.subject,
      senderName: row.sender_name,
      senderAddr: row.sender,
      dateIso: row.date_received,
      bodyMarkdown: body && body.length > 0 ? body : null,
      notionPageId: row.notion_page_id,
      aiPriority: row.ai_priority,
      aiAction: row.ai_action,
      processingStatus: row.processing_status
    }
  } catch {
    return null
  }
}

export interface StartChatInput {
  emailId: number
  userMessage: string
  backendKind: BackendKind
  backendModel: string | null
  backendAgentPageId: string | null
}

export interface StartChatResult {
  sessionId: number
  userMessageId: number
  assistantMessageId: number
}

// One AbortController per (sessionId). A new chat:start on the same
// session pre-empts the previous in-flight stream (rapid-click guard, same
// pattern as Sprint 3 translate). Renderer-initiated abort goes through
// `abortChatSession()`.
const _inflight = new Map<number, AbortController>()

export interface StreamSink {
  send(envelope: ChatStreamEnvelope): void
}

/** Concrete sink used in production — wraps `webContents.send` with a
 *  TOCTOU-safe try/catch (Sprint 4 review codex M-3): a window destroyed
 *  between `isDestroyed()` and `send()` would throw out of the dispatch
 *  loop and abort the entire run; swallowing the throw keeps the DB
 *  writes finishing even though the renderer is gone. */
export function makeWebContentsSink(webContents: WebContents): StreamSink {
  return {
    send(envelope: ChatStreamEnvelope): void {
      if (webContents.isDestroyed()) return
      try {
        webContents.send('chat:stream', envelope)
      } catch {
        // Renderer-side IPC destroyed mid-tick — DB persistence keeps going.
      }
    }
  }
}

/**
 * Start a chat turn. Returns immediately with the persisted session +
 * message ids; the actual streaming runs in the background and pushes
 * events to `sink`. Caller (IPC handler) can return the ids to the
 * renderer so it can pre-render an empty assistant bubble while the
 * stream fills it in.
 */
export async function startChat(input: StartChatInput, sink: StreamSink): Promise<StartChatResult> {
  if (!Number.isInteger(input.emailId) || input.emailId < 0) {
    throw new Error(`startChat: invalid emailId ${input.emailId}`)
  }
  if (typeof input.userMessage !== 'string' || input.userMessage.length === 0) {
    throw new Error('startChat: userMessage must be a non-empty string')
  }

  const session = getOrCreateSession({
    emailId: input.emailId,
    backendKind: input.backendKind,
    backendModel: input.backendModel,
    backendAgentPageId: input.backendAgentPageId
  })

  const userMsg = appendMessage({
    sessionId: session.id,
    role: 'user',
    content: input.userMessage,
    status: 'complete'
  })

  const assistantMsg = appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    model: input.backendModel
  })

  // Pre-empt any prior stream on the same session before swapping in the
  // new AbortController.
  _inflight.get(session.id)?.abort()
  const ac = new AbortController()
  _inflight.set(session.id, ac)

  const backend = getChatBackend(input.backendKind)
  const emailContext = loadEmailContext(input.emailId)

  // Kick off the consumer loop without awaiting — handler returns ids
  // immediately so the renderer can mount the empty bubble.
  void runStream({
    sessionId: session.id,
    assistantMessageId: assistantMsg.id,
    backend,
    history: listMessages(session.id),
    model: input.backendModel,
    agentPageId: input.backendAgentPageId,
    emailContext,
    ac,
    sink
  })

  return {
    sessionId: session.id,
    userMessageId: userMsg.id,
    assistantMessageId: assistantMsg.id
  }
}

interface RunStreamArgs {
  sessionId: number
  assistantMessageId: number
  backend: ReturnType<typeof getChatBackend>
  history: ChatMessage[]
  model: string | null
  agentPageId: string | null
  emailContext: EmailContext | null
  ac: AbortController
  sink: StreamSink
}

async function runStream(args: RunStreamArgs): Promise<void> {
  // Sprint 19 PR-1d.1 — harness gate. When the env flag is on AND the
  // backend speaks Anthropic tool_use, the multi-turn harness owns the
  // run; legacy single-pass continues for notion-agent + the (default)
  // flag-off path. Backend kind is the only stable signal — we don't
  // probe per-instance capability because every backend either fully
  // supports tools or doesn't at all.
  if (isHarnessEnabled() && backendSupportsTools(args.backend.kind)) {
    return runHarness({
      sessionId: args.sessionId,
      assistantMessageId: args.assistantMessageId,
      backend: args.backend,
      initialHistory: args.history,
      model: args.model,
      agentPageId: args.agentPageId,
      emailContext: args.emailContext,
      ac: args.ac,
      sink: args.sink
    })
  }
  const {
    sessionId,
    assistantMessageId,
    backend,
    history,
    model,
    agentPageId,
    emailContext,
    ac,
    sink
  } = args
  let buffer = ''
  let lastUsage: { input: number; output: number; cost: number | null } | null = null
  let modelSeen: string | null = model
  let metadataSeen: Record<string, unknown> | null = null
  // Sprint 4 review (codex N carry-forward): once a backend emits an `error`
  // event, stop persisting and forwarding subsequent events. Today neither
  // notion_agent nor custom_api emits `error` then keeps streaming, but a
  // future backend that did would flip the assistant row error → complete
  // (or worse, leak chunks past the surfaced failure). Sticky flag + break
  // gives us the safe behavior without depending on backend authors to
  // remember.
  let sawError = false

  function forward(event: ChatStreamEvent): void {
    sink.send({ sessionId, messageId: assistantMessageId, event })
  }

  try {
    for await (const event of backend.stream({
      history,
      model,
      agentPageId,
      emailContext,
      signal: ac.signal
    })) {
      if (ac.signal.aborted) break
      if (sawError) break // (codex N) defensive: error already surfaced.

      switch (event.type) {
        case 'chunk': {
          buffer += event.delta
          updateMessage(assistantMessageId, { content: buffer })
          forward(event)
          break
        }
        case 'tool_call': {
          // Tool calls persist as separate `role='tool'` rows so the
          // panel can render them inline above the assistant bubble.
          // Status transitions ('running' → 'ok' / 'error') are
          // emitted by the backend as separate events; the renderer
          // keys by (name, args-hash) to update the row in place.
          appendMessage({
            sessionId,
            role: 'tool',
            content: JSON.stringify({
              name: event.name,
              args: event.args,
              status: event.status,
              durationMs: event.durationMs,
              detail: event.detail
            }),
            status: event.status === 'error' ? 'error' : 'complete',
            errorMessage: event.status === 'error' ? (event.detail ?? null) : null
          })
          forward(event)
          break
        }
        case 'usage': {
          lastUsage = {
            input: event.inputTokens,
            output: event.outputTokens,
            cost: event.costUsd
          }
          modelSeen = event.model ?? modelSeen
          if (event.metadata) metadataSeen = { ...(metadataSeen ?? {}), ...event.metadata }
          forward(event)
          break
        }
        case 'done': {
          modelSeen = event.model ?? modelSeen
          if (event.metadata) metadataSeen = { ...(metadataSeen ?? {}), ...event.metadata }
          updateMessage(assistantMessageId, {
            status: 'complete',
            content: event.finalContent || buffer,
            model: modelSeen,
            tokensInput: lastUsage?.input ?? null,
            tokensOutput: lastUsage?.output ?? null,
            costUsd: lastUsage?.cost ?? null,
            metadata: metadataSeen ? JSON.stringify(metadataSeen) : null
          })
          forward(event)
          break
        }
        case 'error': {
          updateMessage(assistantMessageId, {
            status: 'error',
            errorMessage: event.message,
            model: modelSeen,
            metadata: metadataSeen ? JSON.stringify(metadataSeen) : null
          })
          forward(event)
          sawError = true
          break
        }
      }
    }

    // If we exited the loop because of abort, mark the streaming message
    // as aborted (one tick at most; backend already stopped emitting).
    if (ac.signal.aborted) {
      abortStreamingMessages(sessionId)
    }
  } catch (err) {
    // Unhandled backend exception — surface as error event + DB row.
    if (ac.signal.aborted) {
      abortStreamingMessages(sessionId)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    updateMessage(assistantMessageId, {
      status: 'error',
      errorMessage: message,
      model: modelSeen
    })
    forward({ type: 'error', code: 'E_BACKEND_CRASH', message })
  } finally {
    if (_inflight.get(sessionId) === ac) _inflight.delete(sessionId)
  }
}

// Sprint 14 PR B — inline edit. Drops `editingMessageId` and the tail
// after it, then appends a fresh user message with `newContent` + an
// empty streaming assistant message in the same session, and reruns
// the backend stream. Reuses runStream's IPC/DB plumbing so all the
// edge cases (abort, error event, partial DB writes) flow through one
// path. Returns the new ids so the renderer can pre-render the empty
// assistant bubble, matching startChat's contract.
export interface EditChatInput {
  sessionId: number
  editingMessageId: number
  newContent: string
  backendKind: BackendKind
  backendModel: string | null
  backendAgentPageId: string | null
}

export async function editChatMessage(
  input: EditChatInput,
  sink: StreamSink
): Promise<StartChatResult> {
  if (!Number.isInteger(input.sessionId) || input.sessionId < 0) {
    throw new Error(`editChatMessage: invalid sessionId ${input.sessionId}`)
  }
  if (!Number.isInteger(input.editingMessageId) || input.editingMessageId < 0) {
    throw new Error(`editChatMessage: invalid editingMessageId ${input.editingMessageId}`)
  }
  if (typeof input.newContent !== 'string' || input.newContent.length === 0) {
    throw new Error('editChatMessage: newContent must be a non-empty string')
  }

  const session = getSession(input.sessionId)
  if (!session) {
    const err = new Error(`session ${input.sessionId} not found`) as Error & { code?: string }
    err.code = 'E_NOT_FOUND'
    throw err
  }
  const editing = getMessage(input.editingMessageId)
  if (!editing || editing.session_id !== input.sessionId) {
    const err = new Error(
      `message ${input.editingMessageId} not in session ${input.sessionId}`
    ) as Error & { code?: string }
    err.code = 'E_NOT_FOUND'
    throw err
  }
  if (editing.role !== 'user') {
    const err = new Error(
      `message ${input.editingMessageId} is role=${editing.role}; only user messages can be edited`
    ) as Error & { code?: string }
    err.code = 'E_INVALID_ARG'
    throw err
  }

  // Pre-empt any in-flight stream before mutating DB rows so the
  // soon-to-be-deleted assistant row doesn't get a late chunk write.
  abortChatSession(input.sessionId)

  // Drop editing user message + everything after it. The fresh user
  // message we append below will land with a new id and current
  // created_at, so the assistant turn that follows reads naturally as
  // "the user said X, the assistant replied Y" without a stale tail.
  deleteMessagesFromId(input.sessionId, input.editingMessageId)

  const userMsg = appendMessage({
    sessionId: input.sessionId,
    role: 'user',
    content: input.newContent,
    status: 'complete'
  })

  const assistantMsg = appendMessage({
    sessionId: input.sessionId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    model: input.backendModel
  })

  const ac = new AbortController()
  _inflight.set(input.sessionId, ac)

  const backend = getChatBackend(input.backendKind)
  const emailContext = loadEmailContext(session.email_id)

  void runStream({
    sessionId: input.sessionId,
    assistantMessageId: assistantMsg.id,
    backend,
    history: listMessages(input.sessionId),
    model: input.backendModel,
    agentPageId: input.backendAgentPageId,
    emailContext,
    ac,
    sink
  })

  return {
    sessionId: input.sessionId,
    userMessageId: userMsg.id,
    assistantMessageId: assistantMsg.id
  }
}

/** Renderer-initiated cancel. Idempotent; safe to call when nothing is
 *  in flight. Returns the number of streaming/pending rows it flipped
 *  (0 when the session was already done or never started).
 *
 *  Sprint 19 PR-1d.1: also cancels any harness-pending confirmation
 *  dialogs — without this they'd hang forever waiting for a chat:confirmTool
 *  IPC that the renderer will never send (panel closed). */
export function abortChatSession(sessionId: number): number {
  const ac = _inflight.get(sessionId)
  if (ac) {
    ac.abort()
    if (_inflight.get(sessionId) === ac) _inflight.delete(sessionId)
  }
  cancelConfirmationsForSession(sessionId)
  return abortStreamingMessages(sessionId)
}

/** App-quit hook. Aborts every in-flight stream and clears the map so
 *  backend fetch loops don't keep running into the void. */
export function abortAllChatSessions(): void {
  for (const ac of _inflight.values()) ac.abort()
  _inflight.clear()
}

/** Test-only — clear in-flight map without firing abort. Use sparingly. */
export function __resetChatDispatcher(): void {
  _inflight.clear()
}
