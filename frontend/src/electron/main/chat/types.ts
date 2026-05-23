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
  /** Backend-specific structured payload (e.g. notion-agent thread_id) the
   *  orchestrator JSON-encodes into ai_chat_messages.metadata. Optional —
   *  custom-api backend leaves it null. Sprint 4 review (opus L). */
  metadata?: Record<string, unknown> | null
}

/** Successful completion. `finalContent` is the post-stream canonical
 *  assistant body (mostly identical to the concatenation of `chunk`
 *  deltas, but some backends produce slightly different forms at flush). */
export interface DoneEvent {
  type: 'done'
  finalContent: string
  model: string | null
  /** See UsageEvent.metadata — orchestrator merges this with any prior
   *  metadata observed on usage events (last-write-wins). */
  metadata?: Record<string, unknown> | null
}

/** Backend-internal failure. Orchestrator maps to renderer error UI. */
export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
}

export type ChatStreamEvent = ChunkEvent | ToolCallEvent | UsageEvent | DoneEvent | ErrorEvent

// ── orchestrator → backend inputs ────────────────────────────────────────

/** Email context the backend should inline into its system prompt so the
 *  assistant actually sees the email the panel is asking about. Loaded
 *  by the dispatcher from the SQLite SSoT on session start; null when
 *  no email is open or the row is missing. */
export interface EmailContext {
  internalId: number
  subject: string | null
  senderName: string | null
  senderAddr: string | null
  dateIso: string | null
  /** Markdown form. Already capped at the dispatcher to MAX_BODY_CHARS. */
  bodyMarkdown: string | null
  /** 邮件在 Notion 镜像页 ID, 用来让 Notion Agent 直接定位/更新/挂关联.
   *  无 Notion 同步过的邮件为 null. */
  notionPageId: string | null
}

export interface ChatStreamRequest {
  /** Sequential chat history including the just-inserted user message
   *  the orchestrator wants the backend to respond to. The backend
   *  decides how to pack this into its native prompt format. */
  history: ChatMessage[]
  /** User-selected model alias. If null, backend picks its own default. */
  model: string | null
  /** Notion-only: identifies the Custom Agent to overlay (Jarvis etc.). */
  agentPageId: string | null
  /** Email context — subject + from + date + body markdown — to inline
   *  into the backend's system/user prompt. Sprint 4 review (Opus H-1):
   *  without this, the user's "summarize this email" would reach the
   *  upstream model with zero email content. */
  emailContext: EmailContext | null
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
