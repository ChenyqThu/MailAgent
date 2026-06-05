// V2.1 阶段 3 — chat 数据模型类型（从 electron/main/chat_db.ts 下沉）。
//
// B-pure-unified：chat harness 逻辑搬到 shared/ 后在 UI 进程（renderer /
// browser）跑，需要这些数据模型类型但**不能**引 better-sqlite3（chat_db.ts
// 运行时留在 main）。把纯类型定义抽到这里（零运行时依赖，可被 shared/web 引），
// chat_db.ts re-export 保所有既有 importer（dispatcher/harness/kos_save/
// handlers 等）import 路径不变。
//
// 不变式 1：本文件**零 Electron/Node-only 依赖**（纯 type 声明，无 import）。
//
// 这些类型 1:1 对齐 ai_chat.db 的 ai_chat_sessions / ai_chat_messages /
// chat_tool_call 三表（CREATE 语句见 chat_db.ts），是 chat 持久化的契约面。

export type BackendKind = 'notion-agent' | 'custom-api'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

// Sprint 19 — agent harness audit. Each LLM-proposed tool call gets one row
// in `chat_tool_call`. See docs/agent-harness-design.md §4.5.
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
  email_id: number
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
  created_at: number
  updated_at: number
}

export interface OpenSessionInput {
  emailId: number
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
}

export interface UpdateToolCallPatch {
  status?: ToolCallStatus
  outputJson?: string | null
  durationMs?: number | null
  userEditedInputJson?: string | null
  confirmedAt?: number | null
}
