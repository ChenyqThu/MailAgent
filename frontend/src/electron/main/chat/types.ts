// Sprint 4 — AI chat backend contract (REVIEW-LOG C-04 / BACKEND-INTERFACES §1.6).
//
// Two backends ship in V1 (`notion-agent` + `custom-api`), and we want both
// to plug into one main-process orchestration loop. The interface here is
// the seam:
//   - the orchestrator owns AbortController + session DB writes + IPC fanout
//   - the backend yields semantic events (`chunk` / `tool_call` / `usage` /
//     `done` / `error`) shaped so the renderer can render them without
//     having to care which backend produced them
//
// IMPORTANT: the backend implementations run entirely in the Electron main
// process (REVIEW-LOG C-04 — LLM API keys + Notion token_v2 cookie MUST NOT
// reach the renderer bundle). The renderer only sees the post-IPC stream
// events on `chat:stream`.

import type { BackendKind, ChatMessage } from '../chat_db'

// ── stream events backend → orchestrator ─────────────────────────────────

/** A text delta the assistant just emitted (streaming token). */
export interface ChunkEvent {
  type: 'chunk'
  delta: string
}

/** A tool call the backend dispatched (Notion query, mail fetch, etc.).
 *  Rendered as a mono "log line" in the UI per DESIGN.md §6.3. */
export interface ToolCallEvent {
  type: 'tool_call'
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  /** Sub-second timing for the log line ("0.4s"). */
  durationMs?: number
  /** Optional surfaceable detail (1-line). */
  detail?: string
}

/** Token + cost telemetry. May arrive mid-stream (Anthropic) or only at
 *  done (OpenAI/CRS). Orchestrator persists into ai_chat_messages. */
export interface UsageEvent {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  model: string | null
}

/** Successful completion. `finalContent` is the post-stream canonical
 *  assistant body (mostly identical to the concatenation of `chunk`
 *  deltas, but some backends produce slightly different forms at flush). */
export interface DoneEvent {
  type: 'done'
  finalContent: string
  model: string | null
}

/** Backend-internal failure. Orchestrator maps to renderer error UI. */
export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
}

export type ChatStreamEvent = ChunkEvent | ToolCallEvent | UsageEvent | DoneEvent | ErrorEvent

// ── orchestrator → backend inputs ────────────────────────────────────────

export interface ChatStreamRequest {
  /** Sequential chat history including the just-inserted user message
   *  the orchestrator wants the backend to respond to. The backend
   *  decides how to pack this into its native prompt format. */
  history: ChatMessage[]
  /** User-selected model alias. If null, backend picks its own default. */
  model: string | null
  /** Notion-only: identifies the Custom Agent to overlay (Jarvis etc.). */
  agentPageId: string | null
  /** Cancellation signal — orchestrator aborts this when the user switches
   *  emails / closes the AI panel / hits the explicit cancel button. */
  signal: AbortSignal
}

export interface ChatBackend {
  kind: BackendKind
  /** Yield events until done or the signal aborts. Implementations MUST
   *  respect AbortSignal (`fetch({ signal })` + `for await` polling). */
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>
}

// ── renderer-facing IPC envelope (chat:stream channel) ────────────────────

/** What the renderer subscribes to. The orchestrator wraps every backend
 *  event with the session + assistant message id so the React hook can
 *  match it to the right bubble. */
export interface ChatStreamEnvelope {
  sessionId: number
  messageId: number
  event: ChatStreamEvent
}
