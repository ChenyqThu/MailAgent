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
  trigger: {
    /** 'cron' → cron_headless, 'email_filter' → untrusted_trigger; anything else fail-closes to
     *  untrusted_trigger (strictest) in the gateway. */
    kind: string
    firedAt: string
    emailInternalId?: number
    matchedRule?: AgentRunMatchedRule
  }
  prompt: {
    /** Owner-configured agent prompt (TRUSTED). */
    taskPrompt: string
    /** Server-fenced UNTRUSTED_EMAIL_BODY block (email_filter runs only). Already fenced by W2 —
     *  the gateway concatenates it VERBATIM into the user message, never re-wrapping it. */
    emailEnvelope?: string
  }
  /** Agent model override; null/absent → the gateway default model. */
  model?: string | null
  /** Per-agent tool narrowing (D6). allowedTools absent → no narrowing (full matrix set); [] →
   *  owner explicitly selected zero tools (the gateway intersection empties). */
  toolPolicy?: { allowedTools?: string[] }
  budget: { maxSteps: number; maxRunSeconds: number }
  fallbackModels?: string[]
  sessionTitle: string
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
  created_at: number
  updated_at: number
}

// P2c (task 06-18-custom-ai-harness-agent) — session anchor. 'email' rows carry
// email_id (= anchor_id); 'general' (context-free, Cmd+O) rows have both NULL.
// Mirror of model.ts AnchorType — kept inline so api/types stays the boundary
// surface without importing chat internals.
export type ChatAnchorType = 'email' | 'general'

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
  origin?: string | null
  agent_id?: string | null
  agent_job_id?: string | null
  // harness-chat lane A B4 (task 07-15) — per-session read watermark (ai_chat.db v20 additive
  // column). NULL/undefined = never marked read → no unread badge; unread derives as
  // updated_at > last_read_at (see shared/lib/chatUnread.ts). Optional so pre-v20 rows (and the
  // Python mirror running against a not-yet-migrated DB) stay valid.
  last_read_at?: number | null
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
  created_at: number
  updated_at: number
}

// P3 / PR5 — one installed Skill, as the Settings "Skills" toggle renders it: the
// backend GET /api/agent/skills RESOLVED projection (manifest skills ⋈ agent_config.db
// enable overrides + source_type). `defaultEnabled` is the manifest compile-time seed;
// the user's per-skill override (agent_config.db) sits on top.
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

/** S3 (07-02) — the serve-api fetch face of chat. The legacy engine methods
 *  (start/editMessage/abort/confirmTool/onStream/runSearchAgent/invalidateConfig)
 *  were deleted with the legacy runtime: chat turns run exclusively on the embedded
 *  AI SDK Gateway (useChatRuntime transport → /api/ai/chat), and agentic ⌘K search
 *  goes through @shared/assistant/searchAgentClient → gateway /api/ai/search-agent. */
export interface ChatApi {
  listMessages(sessionId: number): Promise<ChatMessage[]>
  listSessions(emailId: number): Promise<ChatSession[]>
  /**
   * Global cross-email session history for the "AI 会话历史" page. Returns
   * newest-first rows enriched with a first-user-message preview, message
   * count, and the owning email's subject/sender (best-effort — null when
   * sync_store.db is unavailable). Read-only; never throws (degrades to []).
   */
  listAllSessions(includeArchived?: boolean): Promise<ChatSessionListItem[]>
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
   * (`chat:turn-persisted` main→renderer broadcast): EVERY completed-turn persist ('finished') and
   * every approval-pause eager persist ('paused') fires it, so a panel can refresh a session whose
   * DETACHED run settled in the background, and the history lists can refresh unread badges
   * (updated_at just bumped). Deliberately a NEW event — 'chat:session-updated' keeps its 3-value
   * island-settle union untouched. Electron-only; optional — web (HttpApi) omits it and degrades to
   * the /api/ai/run/active poll. Returns an unsubscribe function.
   */
  onTurnPersisted?(
    handler: (payload: { sessionId: number; status: 'finished' | 'paused' }) => void
  ): () => void
}
