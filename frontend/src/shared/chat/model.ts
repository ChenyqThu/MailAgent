// V2.1 阶段 3 — chat 数据模型类型（从 electron/main/chat_db.ts 下沉）。
//
// B-pure-unified：chat harness 逻辑搬到 shared/ 后在 UI 进程（renderer /
// browser）跑，需要这些数据模型类型但**不能**引 better-sqlite3（chat_db.ts
// 运行时留在 main）。把纯类型定义抽到这里（零运行时依赖，可被 shared/web 引），
// chat_db.ts re-export 保所有既有 importer（dispatcher/harness/kos_save/
// handlers 等）import 路径不变。
//
// 不变式 1：本文件**零 Electron/Node-only 依赖**（纯类型 + 派生自类型的纯逻辑，无 import）。
//
// 这些类型 1:1 对齐 ai_chat.db 的 ai_chat_sessions / ai_chat_messages /
// chat_tool_call 三表（CREATE 语句见 chat_db.ts），是 chat 持久化的契约面。

export type BackendKind = 'notion-agent' | 'custom-api'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

// task 06-18-custom-ai-harness-agent Phase 2 (P2c) — chat session anchor.
//   'email'   = anchored to a specific inbox email (email_id NOT NULL, anchor_id = email_id).
//   'general' = a context-free agent session (Cmd+O in P3); email_id IS NULL, anchor_id IS NULL.
// The ai_chat_sessions v7 migration adds a table CHECK coupling anchor_type ↔ email_id/anchor_id
// so a sentinel like email_id=0 is impossible by construction (architecture.md §1.4 / DR-5).
export type AnchorType = 'email' | 'general'

// Sprint 19 — agent harness audit. Each LLM-proposed tool call gets one row
// in `chat_tool_call`. See docs/reference/llm-agent/agent-harness-design.md §4.5.
export type ToolCallStatus =
  | 'pending' // awaiting confirmation (tier=preview/edit)
  | 'confirmed' // user approved, not yet running
  | 'running' // handler in flight
  | 'ok' // handler returned success
  | 'error' // handler returned ToolResult.ok=false OR threw
  | 'canceled' // user clicked Cancel in ConfirmToolDialog
export type ConfirmationTier = 'silent' | 'preview' | 'edit'

export interface ChatSession {
  id: number
  // P2c — nullable since v7: email sessions carry the internal_id, general
  // sessions carry null. Read sites that only ever handle the per-email sidebar
  // (anchor_type='email') still see a number; cross-anchor consumers must null-check.
  email_id: number | null
  // P2c — anchor model (v7). Pre-v7 rows backfill to anchor_type='email',
  // anchor_id=email_id. 'general' rows have both email_id and anchor_id NULL.
  anchor_type: AnchorType
  anchor_id: number | null
  backend_kind: BackendKind
  backend_model: string | null
  backend_agent_page_id: string | null
  created_at: number
  updated_at: number
}

// Global session-history row. Unlike `ChatSession` (per-email, used by the
// in-panel sidebar), this carries enough to render a cross-email history list
// without an N+1 listMessages round-trip per row: the first user-message
// preview and the message count are aggregated in the same SELECT. The
// owning email's subject/sender are NOT here — they live in sync_store.db, so
// handlers/chat.ts joins them in best-effort after the fact.
export interface ChatSessionSummary extends ChatSession {
  /** First user-authored message, truncated server-side. Null for sessions
   *  seeded by automation that never got a user turn. */
  first_user_message: string | null
  message_count: number
}

export interface ChatMessage {
  id: number
  session_id: number
  role: MessageRole
  content: string
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  model: string | null
  status: MessageStatus
  error_message: string | null
  // schema_version=2 (Sprint 4 review opus L carry-forward): JSON blob
  // for backend-specific data that doesn't fit the shared columns. Used
  // today by notion_agent to persist thread_id without abusing the
  // `model` column. Null when no extras. NEVER store secrets here —
  // the field crosses the IPC boundary.
  metadata: string | null
  // task 06-08-chat 需求 5 — extended-thinking summary (Claude extended thinking).
  // First-class column (not metadata) because it's body-level content: streamed,
  // rendered in a collapsible block above the answer, and reloaded from the DB.
  // Null for non-thinking turns + all pre-v6 rows (ALTER ADD default). chat_db.ts
  // v6 migration adds the column; serve-api db.py mirrors the read/write.
  thinking: string | null
  created_at: number
  updated_at: number
}

// P2f (task 06-18-custom-ai-harness-agent Phase 2) — agent memory WAL. One row
// per (scope, key) in ai_chat.db.agent_memory_kv. scope namespaces the fact:
// 'user' = long-term preferences / writing style / mail-handling principles;
// 'skill:<name>' = skill-specific preference. value_json is the serialized fact;
// source_* traces where it came from (session/message/tool) for auditability.
export interface AgentMemoryEntry {
  scope: string
  key: string
  value_json: string
  source_wiki_path: string | null
  // v8 (P2a) — first-class provenance: which chat turn + tool_use proposed this
  // fact (supersedes the source_wiki_path='session:<id>' overload). NULL for
  // pre-v8 rows. priority = user-explicit importance (0 default); the
  // prompt-injection relevance rule orders by priority DESC, updated_at DESC.
  source_session_id: number | null
  source_message_id: number | null
  source_tool_use_id: string | null
  priority: number
  created_at: number
  updated_at: number
}

export interface WriteMemoryInput {
  scope: string
  key: string
  valueJson: string
  /** Legacy free-form provenance pointer (e.g. wiki path). v8 prefers the
   *  structured source_* fields below; kept for back-compat. */
  sourceWikiPath?: string | null
  /** v8 (P2a) — structured provenance of the writing turn. The chat session,
   *  the assistant message, and the memory_write tool_use that proposed it. */
  sourceSessionId?: number | null
  sourceMessageId?: number | null
  sourceToolUseId?: string | null
  /** v8 (P2a) — user-explicit importance. Omit (→ keep existing on update, 0 on
   *  insert) unless the user said a preference is especially important. */
  priority?: number | null
}

export interface OpenSessionInput {
  // P2c — anchor-aware session open. Back-compat: existing callers pass
  // `{ emailId }` (anchorType defaults to 'email'); general sessions pass
  // `{ anchorType: 'general' }` and omit emailId. NEVER pass emailId=0 as a
  // general sentinel — the v7 CHECK rejects it.
  anchorType?: AnchorType
  /** Required when anchorType is 'email' (the default); ignored for 'general'. */
  emailId?: number | null
  backendKind: BackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
}

export interface AppendMessageInput {
  sessionId: number
  role: MessageRole
  content: string
  status: MessageStatus
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  errorMessage?: string | null
  metadata?: string | null
}

export interface UpdateMessagePatch {
  content?: string
  status?: MessageStatus
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  errorMessage?: string | null
  model?: string | null
  metadata?: string | null
  // task 06-08-chat 需求 5 — finalizeMessage persists the full thinking buffer
  // here (harness streams it live, writes it on终态). Omitted on non-thinking turns.
  thinking?: string | null
}

// Sprint 19 — chat_tool_call row + CRUD inputs.

export interface ChatToolCall {
  id: number
  message_id: number
  /** Anthropic toolu_xxx. MUST match across `tool_use` → `tool_result`
   *  round-trip in the LLM message stream. UNIQUE per (message_id). */
  tool_use_id: string
  tool_name: string
  /** Original LLM-proposed input, serialized JSON. */
  input_json: string
  /** Set only when tier was 'edit' and the user changed the input via the
   *  ConfirmToolDialog. The tool handler receives this as effective input;
   *  the result envelope returned to the LLM includes
   *  `{ user_edited: true, original_input, final_input }` so the model
   *  knows what was actually executed. */
  user_edited_input_json: string | null
  /** Tool handler's `ToolResult` serialized as JSON. Null until completion. */
  output_json: string | null
  status: ToolCallStatus
  duration_ms: number | null
  confirmation_tier: ConfirmationTier
  /** Epoch ms when the user clicked Confirm. Null for silent / canceled. */
  confirmed_at: number | null
  /** task 06-08-chat Bug 2 — character offset into the parent assistant
   *  message's `content` at which this tool call was proposed (= the running
   *  buffer length when the harness saw the `tool_use` block, i.e. after this
   *  iter's text but before the next iter's). The renderer splits `content` at
   *  these offsets to interleave tool chips in time order ("text → tool → more
   *  text") instead of stacking all chips below the body. Null for rows written
   *  before v5 (and for non-custom-api / non-harness paths) → renderer falls
   *  back to the legacy "all chips after the body" layout. */
  content_offset: number | null
  created_at: number
  updated_at: number
}

export interface AppendToolCallInput {
  messageId: number
  toolUseId: string
  toolName: string
  inputJson: string
  confirmationTier: ConfirmationTier
  /** Initial status — usually 'pending' for preview/edit tiers, 'running'
   *  for silent. */
  status: ToolCallStatus
  /** task 06-08-chat Bug 2 — running content length at the moment the harness
   *  saw the tool_use block (insertion point for time-ordered interleaving).
   *  Omitted by callers that don't track it → persisted as NULL. */
  contentOffset?: number
}

export interface UpdateToolCallPatch {
  status?: ToolCallStatus
  outputJson?: string | null
  durationMs?: number | null
  userEditedInputJson?: string | null
  confirmedAt?: number | null
}

// ── 后端能力查询（派生自 BackendKind 的纯逻辑）──────────────────────────────
// V2.1 阶段 3：从 chat/config.ts 下沉。dispatcher 下沉 shared 后需在 UI 进程做
// harness-vs-legacy gate，但 config.ts（env 读）留 main —— 而这函数是 backend 的
// 静态能力声明（与 env 无关），故跟 BackendKind 一起落 shared，单一真源在此。

/** 某 backend kind 是否端到端支持 Anthropic tool_use 协议（驱动 dispatcher 的
 *  harness vs legacy 单遍 gate）。notion-agent CLI 是黑盒一次性调用，无 tool_use
 *  循环。纯静态映射 —— 未来加 backend 在此扩展。 */
export function backendSupportsTools(kind: BackendKind): boolean {
  return kind === 'custom-api'
}
