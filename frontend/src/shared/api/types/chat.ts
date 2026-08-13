// ---- S4 custom-agent headless run (task 07-02-s4-custom-agent-core, ADR-003) ----
//
// The gateway fresh-spawn contract. AgentRunSpec is the AUTHORITATIVE spec the gateway PULLS from
// serve-api (GET /api/agent-runs/{id}/spec) after a poke — the POST /api/ai/agent-run body carries
// only {jobId, claimToken}, never these facts (D2). Field names/casing mirror
// src/api/routers/agent_runs.py `_assemble_spec` byte-for-byte (the spec rides inside the serve-api
// success envelope; domainClient unwraps `data`). HeadlessAgentResult is runHeadlessAgent's terminal
// result; the endpoint serializes a subset to the AgentRunWorker, which maps outcome → async_jobs state.

/** One matched email-filter rule descriptor (trigger.matchedRule). All fields optional. */
export interface AgentRunMatchedRule {
  subjectPattern?: string
  senderPattern?: string
  folders?: string[]
}

/** The authoritative headless-run spec pulled from serve-api (never from the poke body). */
export interface AgentRunSpec {
  jobId: number
  agentId: string
  agentTitle: string
  /** Matters MVP P4 (D5/D7) — the SERVER's run-kind stamp, currently the single literal
   *  `'matter_followup'` (absent on every custom-agent run). It is deliberately NOT a trigger
   *  kind: `deriveContextMode` reads it BEFORE the whole trigger.kind ladder, because a Matter
   *  follow-up's trigger.kind is 'manual' and the ladder would fail-close it to
   *  untrusted_trigger — a mode that still admits domain writes.
   *
   *  🔴 The three-mirror sync note below applies to `trigger.kind` ONLY. runKind has its own
   *  gate (an independent assertion block in tests/api/test_context_mode_consistency.py pinning
   *  the agentRun.ts branch + its position ahead of the ladder), and it is deliberately absent
   *  from `deriveHeadlessMode` (shared.ts): that mirror describes CUSTOM-AGENT rule provenance,
   *  and a Matter run is not a custom-agent rule scenario (D5). */
  runKind?: string
  /** P4 — the Matter a follow-up run is anchored to, assembled by `src/matters/run_spec.py`.
   *  `title` feeds the prompt/session title; `id`(internal int) + `publicId` + `runId` are what
   *  `agentRunContextFromSpec` projects into AgentRunContext.matterRun (email-read scoping + the
   *  matter_update_propose registration/identity). 🔴 The model has NO control surface over any of
   *  them — the propose tool's schema carries no matter_id / run_id at all; the handler stamps
   *  both from this server-assembled anchor. Absent on every non-Matter run. */
  matter?: {
    id: number
    publicId: string
    title: string
    runId: number
  }
  trigger: {
    /** 'cron' | 'schedule' → cron_headless, 'email_filter' → untrusted_trigger, 'im' → im_chat
     *  (阶段 0b 预置 —— 阶段 2 飞书对话；当前无任何 spec 会带它); anything else
     *  fail-closes to untrusted_trigger (strictest) in the gateway.
     *  ('schedule' = 07-24 schedule-builder 结构化定时；与 cron 同族 —— 到点就跑、输入里没有
     *  攻击者可控内容。)
     *
     *  🔴 这张表有**三处实现，必须同批改**（漏一边 = 建规盖的 context_mode 与运行时求值的
     *  失配 → 双键 (context_mode, agent_id) 对不上 → owner 配的免卡规则永不命中、恒 HITL）：
     *    1. `frontend/src/ai-gateway/agentRun.ts::deriveContextMode`          —— 运行时求值
     *    2. `frontend/src/shared/components/agents/custom-agent/shared.tsx::deriveHeadlessMode`
     *                                                                         —— UI 展示 / dormant 判定
     *    3. `src/api/routers/agent.py::_derive_rule_context_mode`             —— Python，建规盖章
     *  前两处的一致性由 `frontend/tests/components/contextModeTable.test.ts` 锁死；
     *  第 3 处由 `tests/api/test_agent_policy_peragent.py` 锁死。 */
    id?: string | null
    kind: string
    firedAt: string
    emailInternalId?: number
    matchedRule?: AgentRunMatchedRule
    calendarEventUid?: string
    recurrenceId?: string | null
    occurrenceStartIso?: string
    changeKind?: string
  }
  prompt: {
    /** Owner-configured agent prompt (TRUSTED). */
    taskPrompt: string
    /** Server-fenced UNTRUSTED_EMAIL_BODY block (email_filter runs only). Already fenced by W2 —
     *  the gateway concatenates it VERBATIM into the user message, never re-wrapping it. */
    emailEnvelope?: string
    calendarEnvelope?: string
  }
  /** Agent model override; null/absent → the gateway default model. */
  model?: string | null
  /** Reasoning-effort tier for THIS run (0813 dogfood r3 #10 — Matter-level model overrides).
   *
   *  Typed as a bare string on purpose: like every other spec field this arrives as JSON from
   *  Python, and `runHeadlessAgent` re-derives it through `effortTierFromBody` (thinking.ts),
   *  which fail-closes an unknown tier to "no effort key at all" (the pre-override wire shape).
   *  Absent → byte-identical to before the override existed.
   *
   *  🔴 Only the Matter follow-up assembler emits it today (`src/matters/run_spec.py`); the
   *  custom-agent projection has no such column and keeps omitting it. */
  effort?: string
  /** Per-agent tool narrowing. 🔴 **Fail-closed, never widening** — absent does NOT mean
   *  "no narrowing".
   *
   *  S5 ADR-004 §5.1 (an explicit revision of ADR-003 D6, which this comment used to describe):
   *    - owner never configured it (NULL / key missing in the DB row) → the Python projection
   *      substitutes the **default safe set** (`DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS`), server-side;
   *    - owner-supplied list → verbatim (still ∩ the gateway matrix floor);
   *    - explicit [] → the empty set (zero tools).
   *  So on the wire `allowedTools` is ALWAYS a resolved array — a spec that omits or malforms it
   *  is a broken spec, and the gateway collapses it to [] rather than re-deriving a default
   *  (`agentRun.ts:agentRunContextFromSpec`, "missing / non-array → []").
   *
   *  `skills` follows the SAME shape (S6 W3 / rev3.1 §5.1): always a resolved array on the wire
   *  (NULL → `DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS` substituted server-side), and a spec that omits
   *  it collapses to [] here rather than to applySkillGating's fail-open manual semantic.
   *
   *  `grantExec` / `grantWeb` are the opposite shape — projected ONLY at their non-default values
   *  (`grantExec` only when literally true; `grantWeb` only for 'gated'/'open'), so an ABSENT key
   *  means "no grant", never "unknown". They were on the wire since S5/S6 but missing from this
   *  type, which is why `agentRunContextFromSpec` reached them through an inline structural cast.
   *
   *  `grantConnectors` (stage 1 PR3, harness-expansion epic) rides the grantExec/grantWeb shape:
   *  Python projects it ONLY when non-empty ({connectorId: ceiling}, ceiling ∈ read|write|update —
   *  'delete' is rejected at store time and unrepresentable here), so an ABSENT key means "no
   *  connector grants". The gateway re-derives it via parseConnectorGrants (fail-closed
   *  per-entry), never a raw passthrough.
   *
   *  🔴 Typed here, still parsed defensively there: this arrives as JSON from Python, so the
   *  gateway re-derives every grant from discriminated literals instead of passing the object
   *  through (ADR-004 P1-4). The type states what the server promises; the parser assumes it may
   *  lie. Widen this type only alongside that parser.
   *
   *  Authoritative projection: `src/api/routers/agent_runs.py::_assemble_spec` (~:306-322).
   *  Never re-derive the default here — a second derivation is how the two halves drift apart. */
  toolPolicy?: {
    allowedTools?: string[]
    skills?: string[]
    grantExec?: true
    grantWeb?: 'gated' | 'open'
    grantConnectors?: Record<string, 'read' | 'write' | 'update'>
  }
  budget: { maxRunSeconds: number }
  /** Ordered backup models. `runHeadlessAgent` retries the whole turn on the next entry ONLY when
   *  the attempt failed having produced nothing (see its `producedNothing` note) — so a run that
   *  streamed text, ran a tool, paused at an approval gate or hit the budget is NEVER re-run.
   *  Absent / empty → exactly one attempt, byte-identical to the pre-fallback path.
   *
   *  🔴 Until 0813 this key was projected by Python (`agent_runs.py`, `matters/run_spec.py`) and
   *  read by NOBODY — the chain lived only in the Python LLM client (`llm_agent/client.py`), which
   *  a gateway-driven headless run never goes through. Adding the config surface required adding
   *  the consumer; a saved-but-inert setting is worse than no setting. */
  fallbackModels?: string[]
  sessionTitle: string
  sessionId?: number
  invocation?: {
    instruction: string
    contextNote?: string
    references: Array<{
      type: 'session' | 'report' | 'notion' | 'email' | 'calendar'
      id: string | number
      title?: string
    }>
    parentSessionId: number
    parentToolCallId: string
    invokedBy: 'user' | 'main_agent'
    userRequested: boolean
  }
}

/** runHeadlessAgent's terminal result. The /api/ai/agent-run endpoint maps this to the wire shape
 *  the AgentRunWorker consumes ({ok, outcome, sessionId, steps, summary?, usage?, error?}); the
 *  worker maps outcome → async_jobs terminal state (completed/paused_handoff → succeeded, error →
 *  failed + last_error). */
export interface HeadlessAgentResult {
  ok: boolean
  outcome: 'completed' | 'paused_handoff' | 'error'
  sessionId: number | null
  steps: number
  summary?: string
  usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }
  approvalTtlSec?: number
  /** Present only on outcome==='error'. The endpoint sends `error.code` (a STRING) to the worker,
   *  which stores it as async_jobs.last_error (AgentRunWorker._map_response str()s resp.error). */
  error?: { code: string; message: string }
}

// ---- Sprint 4 §2.1 — AI Chat surface ------------------------------------
//
// These types mirror the main-process `chat_db.ts` + `chat/types.ts`
// shapes. They are duplicated (not imported) because the renderer must
// not import from `src/electron/main/**` — that would pull in
// better-sqlite3 + node:fs into the browser bundle. The IPC boundary is
// the seam; types align by hand and are guarded by the schema-ish unit
// tests in `tests/main/chat_db.test.ts` + `tests/shared/useEmailChat.test.tsx`.

// 'ai-sdk' (P4 Phase 06a cutover) — a chat authored through the embedded AI SDK
// Gateway. New email chats default to this kind; the panel routes the runtime per
// session by backend_kind (ai-sdk → AI SDK Gateway, legacy custom-api →
// ExternalStore, retired notion-agent → read-only). chat_db v13 widened the CHECK.
export type ChatBackendKind = 'notion-agent' | 'custom-api' | 'ai-sdk'
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type ChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

export interface ChatMessage {
  id: number
  session_id: number
  role: ChatMessageRole
  content: string
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  model: string | null
  status: ChatMessageStatus
  error_message: string | null
  /** JSON-encoded backend-specific extras (e.g. notion_agent thread_id).
   *  Renderer treats it as opaque — only the backend that wrote it knows
   *  how to read it. See ai_chat.db schema_version 2 (Sprint 4 opus L). */
  metadata: string | null
  /** task 06-08-chat 需求 5 — Claude extended-thinking summary. Rendered in a
   *  collapsible block above the answer; null for non-thinking turns + pre-v6
   *  rows. Mirror of ai_chat.db schema_version 6 (model.ts ChatMessage). */
  thinking: string | null
  /** v9 (P4 Phase 02) — the AI SDK UIMessage canonical JSON for this turn; null for
   *  legacy-runtime + pre-v9 rows (reload then synthesizes from `content`).
   *  🔴 手抄镜像：`src/shared/chat_model.ts` 的 ChatMessage 是 Electron 侧的同名行形状，v9 加列时
   *  只更新了那一份，这份 API 边界投影漏了 —— 而 `chat.messages.map(chatMessageToUIMessage)` 正是
   *  吃这个类型。运行时没出事纯属侥幸（serve-api `SELECT *` 无 response_model，字段一直在传；
   *  `ReloadableChatMessageRow.ui_message_json` 又是 optional，少这行也照样编译），但类型在对
   *  wire 形状撒谎：谁要是据此认定「这列读不到」而去删读侧的兜底，图片历史当场全灭。
   *  NEVER store secrets here — the field crosses the IPC/HTTP boundary. */
  ui_message_json: string | null
  /** v23 (WP-15 context 环, task 08-05) — 本回合最后一次 provider 调用的 prompt token 数
   *  =「上下文占用」，composer 右下的环/药丸读它。🔴 与 `tokens_input` **语义不同**：那一列是
   *  ai@7 的多 step **求和**（工具循环回合里同一段 prompt 被计好几遍），这一列是**末 step** 的
   *  inputTokens。
   *
   *  **optional 是有意的**（不是漏抄）：这条 wire 由 serve-api `SELECT *`（无 response_model）
   *  产出，行里没有这一列的库（Python 跑在尚未被前端迁到 v23 的 ai_chat.db 上）会整个字段缺席。
   *  读侧一律 `?? null` 兜底 —— 缺席 = 未知 = 不渲染控件，不是 0。 */
  context_tokens?: number | null
  created_at: number
  updated_at: number
}

export interface QueuedInput {
  id: number
  sessionId: number
  runId: string | null
  mode: 'follow_up' | 'steering'
  content: string
  status: 'queued' | 'claimed' | 'sent' | 'canceled' | 'restored'
  createdAt: number
  updatedAt: number
  deliveredMessageId?: number | null
}

// P2c (task 06-18-custom-ai-harness-agent) — session anchor. 'email' rows carry
// email_id (= anchor_id); 'general' (context-free, Cmd+O) rows have both NULL.
// Mirror of model.ts AnchorType — kept inline so api/types stays the boundary
// surface without importing chat internals.
export type ChatAnchorType = 'email' | 'general' | 'matter'
// API/IPC boundary mirror of shared/chat_model.ts. Keep inline so this file remains import-free;
// tests/config/test_chat_type_mirror_parity.py locks the string-union values on both sides.
// 🔴 This is the FILTER vocabulary, NOT the origin COLUMN's value domain (that one is free text —
// 'agent' | 'im' | NULL=interactive, see ChatSession.origin below). Stage 2 PR-1 (task 08-01)
// deliberately adds NO 'im' filter: im rows ride the default 'interactive' clause (it only excludes
// 'agent' — Q18=A desktop visibility) and nothing filters by IM. Adding the literal here without
// implementing it would type-check on both call paths yet behave differently on each (Electron
// listAllSessions falls through to the interactive clause; serve-api's Literal[3] query param 422s).
// A future IM-only filter must land in ALL FOUR mirrors at once: both TS unions, the two listing
// clauses, src/api/routers/chat.py's Literal and src/chat/db.py's validator tuple.
export type ChatSessionOriginFilter = 'interactive' | 'agent' | 'im' | 'all'
export type ChatSessionTriggerKind =
  | 'manual'
  | 'cron'
  | 'schedule'
  | 'email_filter'
  | 'calendar_event_change'
  | 'calendar_before_start'

export interface ChatSession {
  id: number
  // P2c — nullable since ai_chat.db v7: general sessions have no owning email.
  email_id: number | null
  anchor_type: ChatAnchorType
  anchor_id: number | null
  backend_kind: ChatBackendKind
  backend_model: string | null
  backend_agent_page_id: string | null
  // Phase 10 (demo-fidelity) — optional session title: auto-generated by a haiku call after the first
  // turn (via the gateway), user-renamable. null → fall back to the email subject / first user message
  // (the unified history's titleOf). ai_chat.db v14 additive column.
  title: string | null
  // dogfood-2 — soft-delete: archived=true hides the session from listAllSessions without deleting the
  // row. ai_chat.db v15 additive column (DEFAULT 0, existing rows read as false).
  archived: boolean
  created_at: number
  updated_at: number
  // v19 (S4) — a headless custom-agent run (cron/email-triggered) persists a first-class session row
  // marked origin='agent' (NULL/undefined for every interactive session); agent_id + agent_job_id (the
  // async_jobs.job_id as TEXT) link back to report_agent + async_jobs. S6 W2 surfaces these to the
  // renderer so the record view can (a) composer-lock an agent session from ANY entry point (the record
  // is read-mostly, P4) and (b) build the agent-run banner. All three additive/nullable.
  // v22 (stage 2 PR-1, task 08-01) — origin gains the third value 'im' (飞书 conversation, created by
  // the gateway's createImSession; agent_id/agent_job_id stay NULL). AgentThreadList badges it 来自飞书.
  origin?: string | null
  agent_id?: string | null
  agent_job_id?: string | null
  trigger_id?: string | null
  trigger_kind?: ChatSessionTriggerKind | string | null
  trigger_fired_at?: number | null
  // harness-chat lane A B4 (task 07-15) — per-session read watermark (ai_chat.db v20 additive
  // column). NULL/undefined = never marked read → no unread badge; unread derives as
  // updated_at > last_read_at (see shared/lib/chatUnread.ts). Optional so pre-v20 rows (and the
  // Python mirror running against a not-yet-migrated DB) stay valid.
  last_read_at?: number | null
  // custom-agent epic W3 (ai_chat.db v21) — durable history organization metadata.
  pinned_at?: number | null
  starred?: boolean | number
}

export interface ListAllSessionsOptions {
  includeArchived?: boolean
  origin?: ChatSessionOriginFilter
}

// Row of the global "AI 会话历史" page (chat.listAllSessions). A ChatSession
// enriched with an aggregated first-user-message preview + message count
// (from ai_chat.db) and the owning email's subject/sender (joined from
// sync_store.db by handlers/chat.ts). Mirror of ChatSessionListItem in
// `src/electron/main/handlers/chat.ts`; kept in sync by hand across the IPC
// seam like ChatSession / ChatMessage above.
export interface ChatSessionListItem extends ChatSession {
  first_user_message: string | null
  message_count: number
  email_subject: string | null
  email_sender: string | null
  // 0812（事项对话收口进主 chat）— matter-anchored 会话的身份。`anchor_id` 是 matter 的**内部** id，
  // 而事项的 REST 面（context-snapshot / undo）全按 MAT-xxxx 寻址；不带这两个字段，
  // 从历史里选中一个事项会话就只剩一个数字，既拿不到上下文也标不出身份。
  // 🔴 与 email_subject/email_sender 同性质：**join 投影，不是 ai_chat.db 的列**，所以住在
  // ChatSessionListItem 而不是 ChatSession（后者是 DB 行镜像，有 test_chat_type_mirror_parity 守着）。
  // `/chat/sessions/all` 与单条 `GET /chat/sessions/{id}` **都**会填（后者 0812 codex #2 补齐 ——
  // 此前不填，于是走单行读的入口拿到的事项会话被当成普通对话渲染）。
  // 🔴 拿不到（服务端 join 失败 / 旧 serve-api）时读侧**不许**降级成普通会话：判定单源
  // `matterIdentityFromSession` 的第三态 `unresolved` → 界面说「上下文未就绪」并禁发。
  // 非 matter 行恒 null（判据带 anchor_type：email 的 anchor_id 与 matter.id 是两个 id 空间）。
  matter_public_id?: string | null
  matter_title?: string | null
}

// Sprint 19 §D #3 — chat_tool_call audit row, mirrored from main-side
// `src/electron/main/chat_db.ts` so the renderer can type the ChatApi
// listToolCalls() result without crossing the main-process import line.
// Keep the two definitions in sync; payload is plain JSON (better-sqlite3
// → IPC structured-clone).
export type ChatToolCallStatus = 'pending' | 'confirmed' | 'running' | 'ok' | 'error' | 'canceled'
export type ChatConfirmationTier = 'silent' | 'preview' | 'edit'

export interface ChatToolCall {
  id: number
  message_id: number
  tool_use_id: string
  tool_name: string
  /** Original LLM-proposed input JSON. */
  input_json: string
  /** Set only when the user edited the input via ConfirmToolDialog
   *  (confirmation_tier='edit'); null otherwise. */
  user_edited_input_json: string | null
  /** Tool handler's ToolResult serialized; null until the tool completes. */
  output_json: string | null
  status: ChatToolCallStatus
  duration_ms: number | null
  confirmation_tier: ChatConfirmationTier
  confirmed_at: number | null
  /** task 06-08-chat Bug 2 — char offset into the parent assistant message's
   *  `content` where this tool call was proposed; the renderer splits `content`
   *  at these offsets to interleave tool chips in time order. Null for v4 rows
   *  → renderer falls back to "all chips after the body". */
  content_offset: number | null
  /** Phase 03b (v10) — AI SDK Gateway write-tool approval audit. Optional: absent on
   *  read-tool / legacy rows and on pre-v10 serve-api responses. */
  approval_status?: string | null
  approval_hash?: string | null
  /** Phase 04a (v11) — A2UI render payload the rich tool card showed (UI/audit only). */
  ui_payload_json?: string | null
  /** Phase 04b (v12) — outbound-send content hash + idempotency key (email_prepare_send only). */
  content_hash?: string | null
  idempotency_key?: string | null
  /** S2 W1 (v18) — exec tools only: the PolicyRule id that auto-allowed the run without a card
   *  (approval_status='auto_whitelist'). NULL for card-approved / read / legacy rows. Optional
   *  (absent on rows from a pre-v18 DB / older serve-api JSON).
   *  🔴 同 `ui_message_json` 的手抄漏改：v18 加列时只更新了 `src/shared/chat_model.ts`，这份
   *  API 边界投影漏了。两条读路径都是 `SELECT * FROM chat_tool_call`（桌面
   *  chat_db/tool_calls.ts、远程 src/chat/db.py），所以这列一直在 wire 上传 —— 缺的是类型，
   *  于是它在对 wire 形状撒谎。现由 tests/config/test_chat_type_mirror_parity.py 钉住。 */
  whitelist_rule_id?: number | null
  created_at: number
  updated_at: number
}

// P3 / PR5 — one installed Skill, as the Settings "Skills" toggle renders it: the
// backend GET /api/agent/skills RESOLVED projection (manifest skills ⋈ agent_config.db
// enable overrides + source_type). `defaultEnabled` is the manifest compile-time seed;
// the user's per-skill override (agent_config.db) sits on top.
/** 阶段 0.5-③ (PR-2) — one layer's usage in a LAYERED memory.md, as served alongside the
 *  memory doc. Backend-computed (src/memory/memory_md.memory_layer_stats) so the frontend
 *  never re-implements the h2 parser; `name`/order come straight from Python's declaration
 *  order (identity first). `budget` is null for the transient `unsorted` bucket, which has
 *  no quota of its own. */
export interface MemoryLayerStat {
  name: string
  chars: number
  budget: number | null
}

/** PR6 — a Standing Context document (SOUL/AGENT/RULES/USER editable, or MEMORY/SKILLS
 *  projection) as served by GET /api/agent/profile/docs. */
export interface AgentProfileDoc {
  docName: string
  content: string
  contentHash: string | null
  updatedBy: string
  updatedAt: number | null
  editable: boolean
  /** task 07-01 — only present on the `memory` doc: the hard char budget
   *  (config.memory_md_budget_chars) memory.md is always injected within. The
   *  Settings editor shows length / budget prominently. */
  budgetChars?: number
  /** 阶段 0.5-③ (PR-2) — only present on the `memory` doc AND only when its stored content
   *  is layered (structure-driven, not flag-driven): per-layer chars + budget, identity
   *  first. Absent → not layered → the editor shows the single total-budget bar as before. */
  layers?: MemoryLayerStat[]
}

/** PR6 — one entry of a profile doc's version history (GET /api/agent/profile/history). */
export interface AgentProfileHistoryEntry {
  id: number
  docName: string
  oldHash: string | null
  newHash: string
  changedBy: string
  sessionId: number | null
  messageId: number | null
  createdAt: number
}

export interface SkillSummary {
  name: string
  title: string
  description: string
  /** Manifest compile-time default. */
  defaultEnabled: boolean
  /** PR5 — resolved enabled state from the backend agent_config.db (the override
   *  if the user toggled it, else the manifest default). The Settings toggle reads
   *  this directly (no more localStorage overlay). */
  enabled: boolean
  /** PR5 — true if the user has an explicit backend enable override for this skill
   *  (vs falling back to defaultEnabled). */
  overridden: boolean
  /** PR5 — 'builtin' | 'document' | 'local_folder' | 'skill_pack' | 'mcp'. Drives
   *  the Settings "installed vs builtin" affordances (uninstall only for installed). */
  sourceType: string
  /** availability.available — KOS / notion-agent CLI / etc. preconditions met. */
  available: boolean
  /** Reason the skill is unavailable (KOS creds missing, CLI absent…), else null. */
  unavailableReason: string | null
  /** Number of tools the skill owns. */
  toolCount: number
  /** Union of the skill tools' auth_scopes (side-effect summary). */
  scopes: string[]
  installDir: string | null
  trustState: 'trusted' | 'stale' | 'revoked' | null
  lastError: string | null
}

export interface SkillDraftSummary {
  id: string
  name: string
  status: 'draft' | 'valid' | 'invalid' | 'published' | 'discarded'
  manifest: Record<string, unknown> | null
  validation: Record<string, unknown> | null
  files?: Array<{ path: string; bytes: number }>
  replacesInstalled?: boolean
  currentPackageHash?: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentPluginImportResult {
  plugin: { name: string; version?: string; source: string }
  skills: Array<{
    path: string
    status: 'ready' | 'invalid' | 'unsupported'
    draftId?: string
    errors?: string[]
  }>
  mcpServers: Array<{
    name: string
    status: 'detected_not_imported' | 'invalid'
    errors?: string[]
  }>
}

export interface SkillTrustRule {
  id: string
  skillName: string
  packageHash: string
  entrypoint: string
  policy: {
    argvPattern: string[]
    cwdScope: string[]
    readScopes: string[]
    writeScopes: string[]
    networkMode: 'off' | 'gated'
    secretNames: string[]
  }
  trustedAt: number
  revokedAt: number | null
  state: 'trusted' | 'stale' | 'revoked'
}

/** S2 W1 — one exec automation-policy rule (GET /agent/policy/rules, camelCase). A structured
 *  whitelist entry the owner created via the exec approval card's "always allow". `dangerous`
 *  flags a wide interpreter rule (the Settings row shows a red not-a-sandbox warning). `matcher`
 *  is the typed structured matcher (argv template / realpath prefix / origin) — displayed
 *  read-only (narrowing = delete + recreate, never an in-place edit). */
export interface ExecPolicyRule {
  id: number
  capability: string
  matcher: Record<string, unknown>
  contextMode: string
  /** S5 ADR-004 — per-agent headless 规则的归属 agent；null = 全局（manual）规则。 */
  agentId?: string | null
  enabled: boolean
  note: string | null
  createdAt: string
  lastUsedAt: string | null
  useCount: number
  dangerous: boolean
}

/** S5 W5b — 建一条 per-agent 免卡规则（POST /agent/policy/rules）。contextMode 由后端从
 *  agent trigger.kind 派生（表单不可选，ADR-004 §3.3）——本 input 结构性无该字段。 */
export interface CreatePolicyRuleInput {
  /** 'web'（S6 W3, ADR-004 rev3.1 F#1）= gated web_fetch 的 per-agent 域名白名单规则。 */
  capability: 'domain_write' | 'exec' | 'web'
  /** typed matcher：domain_write = {v:1, tool}；exec = pinned-entrypoint 形状（后端形状闸权威）；
   *  web = {v:1, origin}（canonical origin 归一在后端权威 `_normalize_origin`）。 */
  matcher: Record<string, unknown>
  agentId: string
  note?: string
}

/** S5 W5b — 供应链 installed skill 的 entrypoint 清单（GET /agent/skills/entrypoints）。
 *  Settings exec 规则构造器数据源：argv[1] pin = `${dir}/${file}`、cwd_scope pin = dir。 */
export interface SkillEntrypoints {
  name: string
  /** skill 落盘目录绝对路径（Python skill_dir 权威，前端不手抄 skills root）。 */
  dir: string
  /** files_json 清单相对路径（供应链 confirm 落库事实）。 */
  files: string[]
}

/** S2 W4b — server-rendered preview of a fetched (quarantined, NOT yet installed) skill
 *  pack (POST /agent/skills/fetch). The owner reviews these facts, then echoes
 *  quarantineId + packageHash + files back to confirmSkillPack verbatim — the backend
 *  re-hashes the quarantine content and rejects with 409 E_PACK_HASH_MISMATCH when it
 *  changed after preview (TOCTOU). `skillMdExcerpt` is untrusted third-party text:
 *  render as plain text only (never markdown/HTML). */
export interface SkillPackPreview {
  quarantineId: string
  /** 'skill_pack' (URL / local zip) | 'local_folder' (local directory import). */
  sourceType: string
  sourceUri: string | null
  packageHash: string
  /** {relpath: sha256} — echo back to confirmSkillPack as expectedFiles. */
  files: Record<string, string>
  manifest: {
    name: string | null
    type: string | null
    version: string | null
    title: string | null
    description: string | null
    entryHint: string | null
    manifestVersion: number | null
  }
  /** Secret NAMES the manifest declares (values are set separately, write-only). */
  secretNames: string[]
  /** First 4KB of the pack's SKILL.md. */
  skillMdExcerpt: string
}

/** S2 W4b — result of confirming a quarantined pack (POST /agent/skills/confirm, 201). */
export interface SkillConfirmResult {
  name: string
  sourceType: string
  packageHash: string
}

/** S2 W4b — result of the full-cleanup uninstall (POST /agent/skills/uninstall):
 *  agent_skills row + on-disk skill dir + stored secrets in one idempotent sweep. */
export interface SkillUninstallResult {
  name: string
  removed: boolean
  removedDir: boolean
  removedSecrets: number
}

/** S2 W3/W4b — stored per-skill secret metadata (GET /agent/skills/{name}/secrets).
 *  Names + ISO timestamps only — values NEVER leave the backend (write-only model). */
export interface SkillSecretMeta {
  name: string
  updatedAt: string | null
}

/** M3c — user.md 偏好编译结果（POST /api/chat/memory/compile-user-md 返回的 data 块）。
 *  before/after = 编译前后 user.md 内容；beforeHash = 写前 content_hash（前端 rollback 用）；
 *  changed = LLM 是否生成了差异；itemCount = 送进编译器的 mem0 记忆条数。 */
export interface CompileUserMdResult {
  before: string
  beforeHash: string
  after: string
  changed: boolean
  itemCount: number
}

/** 07-16 approval-mode switcher — the owner-global chat approval mode (mirrors the gateway's
 *  tools/types.GlobalApprovalMode; no cross-boundary import — the api types stay gateway-free).
 *  08-05 WP-11 二档化：'manual' = per-tool 审批档决定（默认）; 'bypass' = everything
 *  auto-approves (D1=a 无例外). 🔴 'acceptEdits' 已退役 —— 降级为 per-tool 档的「编辑放行」
 *  一键预设（POST /agent/tool-prefs/preset）；服务端把存量/脏值折算成 'manual'。 */
export type GlobalApprovalMode = 'manual' | 'bypass'

/** 08-05 WP-11 — per-tool approval tier of a built-in write tool（值域镜像 Python
 *  tool_prefs.TOOL_APPROVAL_TIERS；这里只是 wire 类型，注册表本体不手抄——行数据全部来自
 *  GET /api/agent/tool-prefs）。'deny' 只作显式覆盖（出厂默认恒 ask|auto）。 */
export type ToolApprovalTierValue = 'ask' | 'auto' | 'deny'

/** GET /api/agent/tool-prefs 的一行：出厂默认 + 显式覆盖（null=跟随默认）+ 折算 effective。
 *  configurable=false 的行（send / run_command / skill_install×2 / custom_agent CRUD×3）恒
 *  ask、UI 只读展示；dangerAuto=true 的行（calendar_event_delete / notion_agent_chat）设
 *  auto 需红警告 + 一次性确认（WP-10 destructive confirm 同款）。 */
export interface ToolApprovalPrefRow {
  toolName: string
  group: string
  defaultTier: 'ask' | 'auto'
  tier: ToolApprovalTierValue | null
  effectiveTier: ToolApprovalTierValue
  configurable: boolean
  dangerAuto: boolean
}

/** GET /api/agent/tool-prefs 全量负载（写端点也回同形状便于 UI 原地刷新）。
 *  acceptEditsPreset = 「编辑放行」一键预设的成员名单（server canonical，前端不手抄）。 */
export interface ToolApprovalPrefsPayload {
  tools: ToolApprovalPrefRow[]
  sendWhitelist: string[]
  acceptEditsPreset: string[]
  updated?: number
  removed?: number
}

/** issue #54 — POST /chat/kos-doctor 的单步结果（形状对齐 NotionAgentDoctorCheck，
 *  设置页同款逐行 ok/fail 渲染）。check = 步骤标题（后端 emit），detail = 成功摘要或
 *  E_KOS_* 错误码 + message。 */
export interface KosDoctorCheck {
  status: string
  check: string
  detail: string
}

/** S3 (07-02) — the serve-api fetch face of chat. The legacy engine methods
 *  (start/editMessage/abort/confirmTool/onStream/runSearchAgent/invalidateConfig)
 *  were deleted with the legacy runtime: chat turns run exclusively on the embedded
 *  AI SDK Gateway (useChatRuntime transport → /api/ai/chat), and agentic ⌘K search
 *  goes through @shared/assistant/searchAgentClient → gateway /api/ai/search-agent. */
export interface ChatApi {
  listMessages(sessionId: number): Promise<ChatMessage[]>
  listSessions(emailId: number): Promise<ChatSession[]>
  /** Fetch a single row directly, including an agent record excluded from interactive history. */
  getSession(sessionId: number): Promise<ChatSession | null>
  /**
   * Global cross-email session history for the "AI 会话历史" page. Returns
   * newest-first rows enriched with a first-user-message preview, message
   * count, and the owning email's subject/sender (best-effort — null when
   * sync_store.db is unavailable). Read-only; never throws (degrades to []).
   */
  listAllSessions(options?: ListAllSessionsOptions): Promise<ChatSessionListItem[]>
  /** P2c/P2d — general (context-free, anchor_type='general') sessions, newest
   *  first. Separate from listSessions(emailId) so a general session never shows
   *  up in a specific email's sidebar. Read-only; degrades to [] on failure. */
  listGeneralSessions(): Promise<ChatSession[]>
  /**
   * Sprint 14 PR E — spawn a dedicated popout window pinned to the
   * given email's AI chat. Fire-and-forget: the new window shows
   * itself; no resolved promise. Same ai_chat.db backing store as the
   * main inbox panel, so flipping between the two windows is
   * transparent (WAL + busy_timeout already configured in chat_db.ts).
   */
  openPopout(emailId: number): void
  /**
   * Sprint 14 PR J — delete a session + its message rows (CASCADE). Caller
   * (useEmailChat.deleteSession) updates renderer state optimistically before
   * dispatching, then awaits/catches this to toast + re-fetch sessions on
   * failure (P2-4). Callers that don't need rollback (useGeneralChat) attach
   * their own `.catch` to keep the previous warn-only fire-and-forget behavior.
   */
  deleteSession(sessionId: number): Promise<void>
  /**
   * Phase 10 (demo-fidelity) — set a session's title (manual rename, or the gateway's haiku
   * auto-title). PATCH /chat/sessions/{id}/title; deliberately does NOT bump updated_at (a rename
   * never reorders the history list). Awaited so the caller can invalidate the history query after
   * it lands; throws `Error & { code }` on failure.
   */
  updateSessionTitle(sessionId: number, title: string): Promise<void>
  /**
   * dogfood-2 — archive / unarchive a session (soft-delete: archived=true hides the row from
   * listAllSessions without deleting it). PATCH /chat/sessions/{id}/archived; does NOT bump
   * updated_at (same discipline as updateSessionTitle). Awaited so the caller can refresh.
   */
  updateSessionArchived(sessionId: number, archived: boolean): Promise<void>
  /**
   * W8 (task 08-04 WP2) — persist the composer's model pick onto THIS session
   * (`ai_chat_sessions.backend_model`), so re-opening it later restores that model instead of the
   * one global localStorage pref. PATCH /chat/sessions/{id}/model; value is the full providerRef
   * (`providerId:modelId`; a bare legacy id = the 'default' provider), null clears it. Does NOT
   * bump updated_at (same discipline as updateSessionTitle — switching models never reorders
   * history). Best-effort UX face: NEVER throws (the local state switch already took effect; a
   * failed persist only means the next re-open falls back to the global default).
   */
  updateSessionModel(sessionId: number, model: string | null): Promise<void>
  /** Pin/unpin without changing conversation recency. */
  updateSessionPinned(sessionId: number, pinned: boolean): Promise<void>
  /** Toggle the independent star marker without changing conversation recency. */
  updateSessionStarred(sessionId: number, starred: boolean): Promise<void>
  /**
   * harness-chat lane A B4 (task 07-15) — mark a session read: PATCH /chat/sessions/{id}/read sets
   * last_read_at=now (ai_chat.db v20). Does NOT bump updated_at (a read never reorders history).
   * Best-effort UX face: NEVER throws (a pre-v20 DB / unreachable serve-api degrades to no-op —
   * the unread badge just doesn't clear until the next successful mark).
   */
  markSessionRead(sessionId: number): Promise<void>
  /**
   * Sprint 19 / S3 — INSERT a fresh ai_chat_sessions row, bypassing the
   * (email_id, backend_kind, backend_agent_page_id) reuse lookup. The ai-sdk
   * runtime's onEnsureSession creates the session row through this BEFORE the
   * gateway run (eager session creation).
   *
   * Schema v4 dropped the UNIQUE on (email_id, backend_kind,
   * backend_agent_page_id) so this INSERT always creates a brand-new row.
   *
   * P3 — `anchorType` defaults to 'email' (emailId required). Pass
   * `anchorType:'general'` (and omit emailId) to INSERT a fresh general
   * (context-free, Cmd+O) session — the serve-api `POST /chat/sessions/new`
   * + chat_db.ts createNewSession already accept the general anchor (email_id
   * NULL). Never pass emailId for a general session.
   *
   * Throws `Error & { code }` on dispatch failure (E_INVALID_ARG /
   * E_DISPATCH). Caller can fall through to a regular send() on failure;
   * the legacy resurrection path still works as a fallback.
   */
  newSession(input: {
    anchorType?: ChatAnchorType
    emailId?: number | null
    matterId?: number
    backendKind: ChatBackendKind
    backendModel?: string | null
    backendAgentPageId?: string | null
  }): Promise<ChatSession>
  /**
   * Sprint 19 P1-C — explicit "save this assistant turn to KOS" action.
   * Renderer wires a [✨ 保存到 KOS] button per assistant bubble; click
   * invokes this. Service builds a markdown page from (preceding user
   * message + this assistant message) + frontmatter, pushes to KOS at
   * slug `chat-history/mailagent/<email>/<session>/<message>` (D3 default per Lucien 2026-05-23 spec,
   * pending Lucien sync on gbrain namespace).
   *
   * Resolves with the final slug + KOS status + content bytes pushed.
   * Throws `Error & { code }` on E_NOT_FOUND (bad messageId) /
   * E_INVALID_ARG (non-assistant message) / E_KOS_* (KOS unreachable).
   * Renderer surfaces failures in a toast rather than auto-retrying;
   * KOS down is non-fatal — user can retry once it's back.
   */
  saveToKos(input: {
    messageId: number
    slug?: string
    title?: string
  }): Promise<{ slug: string; status: string; contentBytes: number }>
  /**
   * Sprint 19 P1-C — whether the [✨ 保存到 KOS] action is available, i.e.
   * KOS OAuth credentials (KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID +
   * KOS_OAUTH_CLIENT_SECRET) are configured in the main process. The
   * renderer can't read process.env, so the AssistantMessageFooter queries
   * this once on mount and only renders the save button when true. V2 web
   * (HttpApi) returns false — chat-save is Electron-only. Never throws.
   */
  kosAvailable(): Promise<boolean>
  /**
   * issue #54 — KOS 连接检查（Settings 集成页「连接检查」按钮）。POST /chat/kos-doctor：
   * 分步 凭据→health→token→list_pages，返回逐步 ok/fail + detail（形状对齐
   * NotionAgentDoctorCheck，组件同款逐行渲染）。serve-api 不可达时 throw（组件 toast），
   * 与 kosAvailable 的 never-throws 语义有意不同——doctor 是显式动作，失败要可见。
   */
  kosDoctor(): Promise<KosDoctorCheck[]>
  /**
   * Sprint 19 §D #3 — list chat_tool_call audit rows for one assistant
   * message. Renderer ToolCallRow mounts when a message bubble renders;
   * each tool_use the LLM emitted shows up as one row (tool_name, status,
   * input/output JSON, duration). Returns chronological. Empty array when
   * the message had no tool_use blocks (legacy single-pass or no
   * harness involvement). Backed by `listToolCallsForMessage` in chat_db.ts.
   */
  listToolCalls(messageId: number): Promise<ChatToolCall[]>
  /**
   * P3 / PR5 — list Skills for the Settings "Skills" panel. Now reads the RESOLVED
   * list from the backend (GET /api/agent/skills): manifest skills (builtin +
   * installed) joined with the agent_config.db enable overrides + source_type.
   * Read-only; degrades to [] when unreachable (empty/"unavailable" state, never throws).
   */
  listSkills(): Promise<SkillSummary[]>
  /**
   * PR5 — enable/disable a skill (POST /api/agent/skills/{name}/enabled). Persists
   * to the backend agent_config.db (replaces the old per-surface localStorage toggle).
   * The gateway re-reads /chat/config on a 15s TTL, so the toggle reaches the next
   * turn's tool catalog without client-side invalidation. Throws `Error & { code }`
   * on failure (E_NOT_FOUND for an unknown skill, E_INVALID_ARG for a bad arg).
   */
  setSkillEnabled(name: string, enabled: boolean): Promise<void>
  listSkillDrafts(): Promise<SkillDraftSummary[]>
  getSkillDraft(id: string): Promise<SkillDraftSummary>
  readSkillDraftFile(id: string, path: string): Promise<string>
  publishSkillDraft(id: string, enabled: boolean): Promise<void>
  discardSkillDraft(id: string): Promise<void>
  importAgentPlugin(zipBase64: string): Promise<AgentPluginImportResult>
  listSkillTrust(
    name: string
  ): Promise<{ currentPackageHash: string | null; trusts: SkillTrustRule[] }>
  grantSkillTrust(
    name: string,
    entrypoint: string,
    policy: SkillTrustRule['policy']
  ): Promise<SkillTrustRule>
  revokeSkillTrust(name: string, trustId: string): Promise<void>
  /**
   * 07-16 approval-mode switcher — read the owner-global chat approval mode
   * (GET /api/agent/approval-mode; persisted in backend agent_config.db so desktop and the
   * remote web share ONE value). 🔴 THROWS when unreachable (codex r1 P1-1: the UI must render
   * an explicit unknown state + retry — it must never claim Manual while the persisted mode
   * could be bypass). An out-of-domain value in a successful envelope folds to 'manual'
   * (server semantics: dirty rows read as manual).
   */
  getApprovalMode(): Promise<GlobalApprovalMode>
  /**
   * 07-16 — switch the owner-global chat approval mode (PUT /api/agent/approval-mode). Owner
   * UI ONLY (composer chip) — the model has no tool that reaches this endpoint. The gateway
   * hot-reads the mode per manual run (short TTL), so a switch applies to the next turn without
   * restart and persists across app restarts / new sessions. Returns the SERVER-CANONICAL mode
   * echoed by the PUT (the pessimistic store displays only confirmed values, codex r1 P1-2);
   * throws Error&{code} on failure (the store re-GETs to converge).
   */
  setApprovalMode(mode: GlobalApprovalMode): Promise<GlobalApprovalMode>
  /** P4 owner setting; missing row is server-canonical 'on'. */
  getAutoCompact(): Promise<'on' | 'off'>
  /** P4 owner-only write face. No gateway tool can reach this endpoint. */
  setAutoCompact(mode: 'on' | 'off'): Promise<'on' | 'off'>
  /**
   * 08-05 WP-11 — read the per-tool approval tiers of every built-in write tool + the send
   * recipient whitelist + the acceptEdits preset membership (GET /api/agent/tool-prefs).
   * Throws when unreachable (the Settings section renders an error/retry state).
   */
  getToolPrefs(): Promise<ToolApprovalPrefsPayload>
  /**
   * 08-05 WP-11 — set/clear ONE tool's explicit tier (PUT /api/agent/tool-prefs/{name};
   * tier null = 回出厂默认). Owner UI ONLY（无 gateway 工具可达——policy_rules 纪律）。
   * The gateway hot-reads tiers per manual run (short TTL) — a change applies within seconds.
   */
  setToolPref(
    toolName: string,
    tier: ToolApprovalTierValue | null
  ): Promise<ToolApprovalPrefsPayload>
  /**
   * 08-05 WP-11 — group-level bulk tier set (POST /api/agent/tool-prefs/bulk).
   * group omitted = every configurable tool; tier null = bulk reset那一组回默认.
   */
  bulkSetToolPrefs(input: {
    tier: ToolApprovalTierValue | null
    group?: string
  }): Promise<ToolApprovalPrefsPayload>
  /**
   * 08-05 WP-11 — apply the「编辑放行」preset (POST /api/agent/tool-prefs/preset):
   * batch-sets the retired acceptEdits member list to explicit 'auto' (membership canonical
   * server-side).
   */
  applyToolPrefsPreset(): Promise<ToolApprovalPrefsPayload>
  /**
   * 08-05 WP-11 — Reset permissions (POST /api/agent/tool-prefs/reset): clear EVERY explicit
   * override, all tools back to factory defaults.
   */
  resetToolPrefs(): Promise<ToolApprovalPrefsPayload>
  /**
   * 08-05 WP-11 (D2=a) — write the send recipient whitelist (PUT /api/agent/send-whitelist).
   * Entries = full emails or '@domain'; empty list = the send always asks. Throws Error&{code}
   * (E_INVALID_ARG carries which entry was rejected).
   */
  setSendWhitelist(recipients: string[]): Promise<string[]>
  /**
   * S2 W1 — list the exec automation-policy rules for the Settings 「自动化策略」 page
   * (GET /agent/policy/rules). Structured whitelist rules the owner created via the exec
   * approval card's "always allow" affordance. Read-only; degrades to [] when unreachable.
   * S5 W5b: optional `agentId` narrows to one custom agent's per-agent headless rules
   * (the CustomAgentDrawer 自动化策略 section); omitted = all rows (S2 call sites unchanged).
   */
  listPolicyRules(params?: { agentId?: string }): Promise<ExecPolicyRule[]>
  /**
   * S5 W5b — create one per-agent whitelist rule (POST /agent/policy/rules). The ONLY
   * creation channel is the Settings per-agent 自动化策略 form (ADR-004 D5 — the model has
   * no rule-writing tool; the island card has no "always allow (this agent)" affordance).
   * contextMode is derived server-side from the agent trigger. Throws Error&{code} with the
   * backend shape-gate detail verbatim (raw {any} / non-skill entrypoint / ownership 400s).
   */
  createPolicyRule(input: CreatePolicyRuleInput): Promise<ExecPolicyRule>
  /**
   * S5 W5b — supply-chain installed skill entrypoint candidates for the exec rule builder
   * (GET /agent/skills/entrypoints, flag-gated 404 when custom agents are off). Degrades
   * to [] when unreachable (the builder shows a "no installed skills" empty state).
   */
  listSkillEntrypoints(): Promise<SkillEntrypoints[]>
  /**
   * S2 W1 — enable/disable one policy rule (PATCH /agent/policy/rules/{id}). Disabling stops it
   * auto-allowing exec runs (they go back to always-ask) without deleting it. Throws Error&{code}.
   */
  setPolicyRuleEnabled(id: number, enabled: boolean): Promise<void>
  /**
   * S2 W1 — delete one policy rule (DELETE /agent/policy/rules/{id}). Idempotent. To narrow a
   * rule the owner deletes + re-creates (matchers are NOT editable — no silent widening).
   */
  deletePolicyRule(id: number): Promise<void>
  /**
   * M3c — 从 mem0 累积的偏好记忆编译合并进 user.md。手动触发（Settings 按钮）。
   * POST /api/chat/memory/compile-user-md → CompileUserMdResult。
   * flag-off（MAILAGENT_USER_MD_COMPILE）→ backend 返 403（E_DISABLED）→ caller 捕获处理。
   */
  compileUserMd(): Promise<CompileUserMdResult>
  /**
   * M3c — 把 user.md 回滚到指定历史版本（按 targetHash 定位）。
   * POST /api/agent/profile/docs/{name}/rollback，body = {targetHash, updatedBy?}。
   * 用于编译结果的一键 rollback（toHash = CompileUserMdResult.beforeHash）。
   * Throws Error & { code } on failure.
   */
  rollbackProfileDoc(input: { name: string; toHash: string }): Promise<void>
  /**
   * Settings 身份文档编辑器 — list all profile docs (SOUL/AGENT/RULES/USER +
   * MEMORY/SKILLS projections). GET /api/agent/profile/docs → AgentProfileDoc[].
   * Degrades to [] when unreachable (never throws).
   */
  listProfileDocs(): Promise<AgentProfileDoc[]>
  /**
   * Settings 身份文档编辑器 — read one profile doc with full content + hash.
   * GET /api/agent/profile/docs/{name}. Throws Error & { code } on failure
   * (E_NOT_FOUND for unknown doc name).
   */
  readProfileDoc(name: string): Promise<AgentProfileDoc>
  /**
   * Settings 身份文档编辑器 — write / update one profile doc.
   * POST /api/agent/profile/docs/{name}. RULES content passes through
   * validate_rules_content server-side — jailbreak / override phrasing → E_INVALID_ARG.
   * Caller catches E_INVALID_ARG to surface the rejection without overwriting.
   * Throws Error & { code } on failure.
   */
  setProfileDoc(input: {
    name: string
    content: string
    updatedBy?: string
    sessionId?: number
    messageId?: number
  }): Promise<AgentProfileDoc>
  /**
   * Settings 身份文档编辑器 — version history for one profile doc, newest-first.
   * GET /api/agent/profile/history?docName=. Degrades to [] when unreachable.
   */
  listProfileHistory(docName?: string): Promise<AgentProfileHistoryEntry[]>
  /**
   * S2 W4b — two-phase install, phase 1: download (URL) / import (local zip or dir) a
   * skill pack into quarantine + return the server-rendered preview (POST
   * /agent/skills/fetch). Exactly one of sourceUrl / localPath. NOT an install — the
   * owner reviews the preview, then calls confirmSkillPack. Throws Error&{code}
   * (E_PACK_* / E_SSRF_BLOCKED / E_UPSTREAM / E_INVALID_ARG).
   */
  fetchSkillPack(input: { sourceUrl?: string; localPath?: string }): Promise<SkillPackPreview>
  /**
   * S2 W4b — two-phase install, phase 2: confirm the quarantined pack (POST
   * /agent/skills/confirm). Pass the preview's packageHash + files verbatim — the
   * backend re-hashes the quarantine content and throws 409 E_PACK_HASH_MISMATCH when
   * it changed after preview (the UI tells the owner to re-fetch). Throws Error&{code}.
   */
  confirmSkillPack(input: {
    quarantineId: string
    expectedPackageHash: string
    expectedFiles?: Record<string, string>
  }): Promise<SkillConfirmResult>
  /**
   * S2 W4b — full-cleanup uninstall of an installed pack (POST /agent/skills/uninstall):
   * agent_skills row + on-disk skill dir + stored secrets in one idempotent sweep.
   * NEVER the legacy DELETE /agent/skills/{name} (row-only for non-pack rows).
   * Throws Error&{code}.
   */
  uninstallSkillPack(name: string): Promise<SkillUninstallResult>
  /**
   * S2 W4b — read an installed skill's non-sensitive config.json (GET
   * /agent/skills/{name}/config). Plaintext owner surface shared with the skill's
   * scripts; secrets are NOT here (write-only secrets endpoints). Missing file → {}.
   * Throws Error&{code} (E_NOT_FOUND when the skill isn't installed on disk).
   */
  getSkillConfig(name: string): Promise<Record<string, unknown>>
  /**
   * S2 W4b — overwrite an installed skill's config.json (PUT /agent/skills/{name}/config).
   * Body must be a JSON object, ≤64KB serialized. Throws Error&{code}.
   */
  putSkillConfig(name: string, config: Record<string, unknown>): Promise<void>
  /**
   * S2 W3/W4b — list a skill's STORED secret names + updated timestamps (GET
   * /agent/skills/{name}/secrets). Values never leave the backend. Degrades to []
   * when unreachable.
   */
  listSkillSecretMeta(name: string): Promise<SkillSecretMeta[]>
  /**
   * S2 W3/W4b — set/replace one per-skill secret (PUT
   * /agent/skills/{name}/secrets/{secretName}). Write-only: the response never echoes
   * the value; the Settings input clears after a successful PUT. Secret names are
   * validated server-side (env-name regex + reserved deny). Throws Error&{code}.
   */
  putSkillSecret(name: string, secretName: string, value: string): Promise<void>
  /**
   * S2 W3/W4b — delete one per-skill secret (DELETE
   * /agent/skills/{name}/secrets/{secretName}). Idempotent. Throws Error&{code}.
   */
  deleteSkillSecret(name: string, secretName: string): Promise<void>
  /**
   * Part B (island live-refresh) — subscribe to server-side approval-resume settles
   * (`chat:session-updated` main→renderer broadcast): the island approved/rejected a paused
   * HITL turn and the gateway resumed it server-side, so the session's ai_chat.db rows changed
   * OUTSIDE the renderer's useChat state. An open panel matching `sessionId` reloads its
   * messages. Electron-only (island agent runs in main); optional — web (HttpApi) omits it.
   * Returns an unsubscribe function.
   */
  onSessionUpdated?(
    handler: (payload: { sessionId: number; status: 'completed' | 'rejected' | 'error' }) => void
  ): () => void
  /**
   * harness-chat lane A B2 (task 07-15) — subscribe to gateway turn persists
   * (`chat:turn-persisted` main→renderer broadcast): EVERY completed-turn persist ('finished'),
   * approval-pause eager persist ('paused'), and Compact row append ('compacted') fires it, so a
   * panel can refresh DB-owned history. A compacted event received during the panel's own stream is
   * queued until that stream settles, avoiding a mid-stream runtime remount. Electron-only;
   * optional — web (HttpApi) omits it and degrades to reload/poll convergence.
   *
   * codex r2 [C] — `runId` is the run's gateway ActiveRunRegistry id (per-run settle dedup +
   * own-run attribution in useBackgroundChatRun); null = an unleased persist (headless agent run).
   */
  onTurnPersisted?(
    handler: (payload: {
      sessionId: number
      status: 'finished' | 'paused' | 'compacted'
      runId: string | null
    }) => void
  ): () => void
  onQueuedInputChanged?(handler: (payload: { sessionId: number }) => void): () => void
}
