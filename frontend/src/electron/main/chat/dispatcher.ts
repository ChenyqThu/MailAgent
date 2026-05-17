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
  getOrCreateSession,
  listMessages,
  updateMessage,
  type BackendKind,
  type ChatMessage
} from '../chat_db'
import { getChatBackend } from './registry'
import type { ChatStreamEnvelope, ChatStreamEvent } from './types'

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

/** Concrete sink used in production — wraps `webContents.send`. */
export function makeWebContentsSink(webContents: WebContents): StreamSink {
  return {
    send(envelope: ChatStreamEnvelope): void {
      if (webContents.isDestroyed()) return
      webContents.send('chat:stream', envelope)
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

  // Kick off the consumer loop without awaiting — handler returns ids
  // immediately so the renderer can mount the empty bubble.
  void runStream({
    sessionId: session.id,
    assistantMessageId: assistantMsg.id,
    backend,
    history: listMessages(session.id),
    model: input.backendModel,
    agentPageId: input.backendAgentPageId,
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
  ac: AbortController
  sink: StreamSink
}

async function runStream(args: RunStreamArgs): Promise<void> {
  const { sessionId, assistantMessageId, backend, history, model, agentPageId, ac, sink } = args
  let buffer = ''
  let lastUsage: { input: number; output: number; cost: number | null } | null = null
  let modelSeen: string | null = model

  function forward(event: ChatStreamEvent): void {
    sink.send({ sessionId, messageId: assistantMessageId, event })
  }

  try {
    for await (const event of backend.stream({
      history,
      model,
      agentPageId,
      signal: ac.signal
    })) {
      if (ac.signal.aborted) break

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
          forward(event)
          break
        }
        case 'done': {
          modelSeen = event.model ?? modelSeen
          updateMessage(assistantMessageId, {
            status: 'complete',
            content: event.finalContent || buffer,
            model: modelSeen,
            tokensInput: lastUsage?.input ?? null,
            tokensOutput: lastUsage?.output ?? null,
            costUsd: lastUsage?.cost ?? null
          })
          forward(event)
          break
        }
        case 'error': {
          updateMessage(assistantMessageId, {
            status: 'error',
            errorMessage: event.message,
            model: modelSeen
          })
          forward(event)
          // Don't break the for-await — the backend chose to emit error
          // and may follow with `done` or simply finish; either way the
          // DB now reflects the failure.
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

/** Renderer-initiated cancel. Idempotent; safe to call when nothing is
 *  in flight. Returns the number of streaming/pending rows it flipped
 *  (0 when the session was already done or never started). */
export function abortChatSession(sessionId: number): number {
  const ac = _inflight.get(sessionId)
  if (ac) {
    ac.abort()
    if (_inflight.get(sessionId) === ac) _inflight.delete(sessionId)
  }
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
