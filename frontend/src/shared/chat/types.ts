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

import type { BackendKind, ChatMessage } from './model'

// ── stream events backend → orchestrator ─────────────────────────────────

/** A text delta the assistant just emitted (streaming token). */
export interface ChunkEvent {
  type: 'chunk'
  delta: string
}

/** task 06-08-chat 需求 5 — extended-thinking delta (Claude extended thinking,
 *  Anthropic `thinking_delta`). A separate event from `chunk` so downstream
 *  consumers (harness forward / useEmailChat onStream / MessageList render)
 *  keep the model's reasoning summary out of the canonical answer `content`
 *  — it accumulates into `ChatMessage.thinking` and renders in a collapsible
 *  block above the answer. Only the custom-api Anthropic path emits it (and
 *  only when the per-turn thinking toggle is on). */
export interface ThinkingEvent {
  type: 'thinking'
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
  /** Sprint 19 — Anthropic-style stop_reason. `tool_use` tells the
   *  harness loop "the model wants to call tools, do another iter";
   *  `end_turn` means stop. Optional for backends that don't expose
   *  it (notion-agent CLI always returns end_turn semantics). */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  /** See UsageEvent.metadata — orchestrator merges this with any prior
   *  metadata observed on usage events (last-write-wins). */
  metadata?: Record<string, unknown> | null
  /** task 06-08-chat 第二波 Bug A — the structured thinking/redacted_thinking
   *  blocks the model emitted THIS iter, in SSE order. The harness puts these
   *  (unmodified, incl. signature) at the FRONT of the assistant turn it
   *  appends to multi-turn history — Anthropic requires the prior thinking
   *  block to be passed back verbatim when the same turn calls tools (extended
   *  thinking + tool use hard constraint, research §2.4 / §6 方案 B). Empty /
   *  omitted when thinking is off (zero-regression: harness sees []). */
  thinkingBlocks?: AnthropicThinkingBlock[]
}

/** Backend-internal failure. Orchestrator maps to renderer error UI. */
export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
}

/** Sprint 19 — LLM proposes a tool invocation (Anthropic `tool_use` content
 *  block / OpenAI `tool_calls`). The harness loop accumulates these in the
 *  current iter, dispatches them between iterations, then injects the
 *  resulting tool_result blocks back into history for the next stream call.
 *
 *  `toolUseId` MUST be stable across history serialization — Anthropic
 *  requires the next-turn `tool_result.tool_use_id` to match this exactly.
 *  Persisted in `chat_tool_call.tool_use_id`. */
export interface ToolUseEvent {
  type: 'tool_use'
  toolUseId: string
  name: string
  input: unknown
}

/** Sprint 19 — Result of a tool execution. Emitted by the harness, not by
 *  the LLM backend. The renderer renders these as the second half of a
 *  ToolCallRow (status + duration + collapsed output). */
export interface ToolResultEvent {
  type: 'tool_result'
  toolUseId: string
  status: 'ok' | 'error' | 'canceled'
  output?: unknown
  errorMessage?: string
  durationMs: number
}

/** Sprint 19 — Harness detected a tool whose `confirmationTier` is
 *  `'preview'` or `'edit'`. The renderer pops a `ConfirmToolDialog`; the
 *  user either approves (optionally editing input) or cancels via the
 *  `chat:confirmTool` IPC channel. Until the user responds, the harness
 *  blocks on a per-`toolUseId` promise. */
export interface PendingConfirmationEvent {
  type: 'pending_confirmation'
  toolUseId: string
  toolName: string
  input: unknown
  /** One-line human-readable summary the dialog shows above the JSON. */
  preview?: string
  tier: 'preview' | 'edit'
}

export type ChatStreamEvent =
  | ChunkEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolUseEvent
  | ToolResultEvent
  | PendingConfirmationEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent

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
  /** AI 分类结果 (LLM agent 已跑过; null = 未分类 / dead-letter).
   *  - aiPriority: '🔴 紧急' / '🟡 重要' / '🟢 一般' / '⚪ 低' (LLM enum)
   *  - aiAction:   '需要回复' / '需要决策' / '需要 Review' / '需要会议' /
   *                '需要跟进' / '等待响应' / '仅供参考' / '已完结'
   *  - processingStatus: '未处理' / 'AI Reviewed' / '已同步' / '已完成' /
   *                      '草稿已创建'
   *  让 chat agent 看到 'AI 已标 🟡 重要 + 需要决策' 立刻有判断依据,
   *  不必去 query AI 字段再问一轮. */
  aiPriority: string | null
  aiAction: string | null
  processingStatus: string | null
}

/** Sprint 19 — Anthropic-shape tool descriptor a backend can pass to the
 *  upstream LLM. The harness emits these via `ToolRegistry.toAnthropicSchema()`.
 *  Backends that don't support tool calling (notion-agent CLI) ignore this. */
export interface BackendToolDescriptor {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** task 06-08-chat 第二波 Bug A — Anthropic extended-thinking content blocks.
 *  A `thinking` block carries the (summarized) reasoning text + an opaque
 *  integrity `signature`; a `redacted_thinking` block carries only encrypted
 *  `data` (no readable text). Both MUST be passed back to the API UNMODIFIED
 *  (signature byte-exact) on the next turn when the same assistant turn calls
 *  tools — otherwise Anthropic returns 400. Used for DoneEvent.thinkingBlocks
 *  + the harness's multi-turn history rebuild (research §2.4). */
export type AnthropicThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** Sprint 19 PR-1d — Anthropic content block discriminator. The harness
 *  reuses these to build multi-turn `iterHistory` entries: an assistant
 *  turn that ends in tool_use has `content: [thinking…, text, tool_use…]`
 *  (thinking blocks lead, task 06-08-chat 第二波 Bug A); the next user turn
 *  carries the `tool_result` blocks. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** Sprint 19 PR-1d — Anthropic-shape history message for the multi-turn
 *  loop. When `ChatStreamRequest.iterHistory` is set, the backend uses
 *  this as messages[] verbatim (bypassing the ChatMessage[] →
 *  buildAnthropicMessages translation) so tool_use/tool_result blocks stay
 *  in their native multi-block shape — ChatMessage.content is a single
 *  string and can't represent the tool_use protocol. */
export interface AnthropicHistoryMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/** task 06-08-chat 需求 5 — per-turn extended-thinking options. Threaded
 *  ChatStartOpts → dispatcher → harness → ChatStreamRequest. MVP carries only
 *  `enabled`; budget_tokens (manual sonnet) / effort (adaptive opus) use
 *  hardcoded defaults in the custom-api backend (research §5.3). */
export interface ThinkingOptions {
  enabled: boolean
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
  /** Sprint 19 — tools the LLM may call. Omitted (or empty) → backend
   *  must not pass `tools` to the upstream API. The harness loop sets this
   *  to `registry.toAnthropicSchema()`; the legacy single-turn path leaves
   *  it undefined. */
  tools?: BackendToolDescriptor[]
  /** Sprint 19 PR-1d — when set, the backend MUST use this as Anthropic
   *  messages[] verbatim, ignoring `history`. The harness uses this so
   *  multi-turn tool_use / tool_result content blocks survive between
   *  iterations within one user turn. Undefined → fall back to translating
   *  `history: ChatMessage[]` via the backend's own builder (legacy path). */
  iterHistory?: AnthropicHistoryMessage[]
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle. When
   *  `enabled`, the custom-api Anthropic path injects the `thinking` request
   *  param (manual for sonnet / adaptive+effort for opus) and emits
   *  ThinkingEvent deltas. MVP取舍: thinking on → tools are NOT passed
   *  upstream (single-turn end_turn, avoids the multi-turn thinking-block
   *  passback hard constraint, research §2.4 / §6 方案 A). Undefined/off →
   *  identical to today. */
  thinking?: ThinkingOptions
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
