// chat-panel P4 Phase 03a — MailAgentDomainClient (AI SDK Gateway → Python serve-api).
//
// The AI SDK Gateway read tools (frontend/src/ai-gateway/tools/*) reach the
// MailAgent domain through this typed HTTP client — never SQLite directly. It is
// pure Node (global `fetch`, no electron/keytar/chat_db), so the gateway core stays
// harness-testable; the Electron wrapper (ai_gateway_lifecycle.ts) constructs one
// with the loopback serve-api base URL (resolveApiPort) + the same-machine local
// token (local_token.ts) and injects it into the tool registry.
//
// 🔴 Auth: every request carries the `X-MailAgent-Local-Token` header (mirrors
//    src/api/auth.py's local-token leg). The token lives only in main; the renderer
//    never sees it. loopback ≠ safe → the custom header is the CSRF guard.
//
// 🔴 Wire-param fidelity (spike-discovered, see the per-endpoint notes): the serve-api
//    read endpoints use INCONSISTENT param names — /email/list takes camelCase aliases
//    (sinceDate/fromAddr/isRead), /email/search takes `q`/`since`/`until`,
//    /attachment/search takes `q`. The methods below encode the exact wire names so a
//    gateway tool's result matches the legacy HttpChatPlatform byte-for-byte (parity).

import type {
  EmailGet_EmailRecord,
  EmailList_EmailListItem,
  MailagentEmailBody
} from '@shared/types/cli.gen'
import type {
  AgentRunHistoryItem,
  AgentRunListItem,
  AgentRunSpec,
  AgentRunToolOptions,
  AssistantIdentity,
  ReportBlock,
  ReportAgentConfig,
  ReportConfigPatch,
  ReportAgentCreateInput,
  ReportDetail,
  ReportListItem,
  SearchResult
} from '@shared/api/types'
import type { GroupConfig } from '@shared/chat_model'

/** A serve-api domain error surfaced to the caller (tool execute turns it into a
 *  tool-error part). Mirrors the http_client ApiError shape ({code, message, hint?,
 *  httpStatus?}). `code` is the serve-api envelope error code (E_NOT_FOUND /
 *  E_INVALID_ARG / E_KOS_* / E_UPSTREAM / E_INTERNAL / E_NETWORK …). */
export class DomainError extends Error {
  readonly code: string
  readonly hint?: string
  readonly httpStatus?: number
  /** Structured error payload (`error.data`) when the endpoint carries one. Today only the library
   *  CAS 409 does (E_VERSION_CONFLICT → {content_hash, content}, design §4); every other envelope
   *  leaves it undefined. */
  readonly data?: unknown
  constructor(
    code: string,
    message: string,
    opts?: { hint?: string; httpStatus?: number; data?: unknown }
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.hint = opts?.hint
    this.httpStatus = opts?.httpStatus
    this.data = opts?.data
  }
}

type QueryValue = string | number | boolean | undefined | null

export interface DomainClientConfig {
  /** serve-api base URL incl. the /api prefix, e.g. http://127.0.0.1:8200/api. */
  baseUrl: string
  /** X-MailAgent-Local-Token value (main-process ephemeral token). null → header
   *  omitted (dev / pm2 backend where the local-token leg is disabled). */
  localToken: string | null
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/** Search filters for the metadata-filter email list (email_list_filter tool). */
export interface DomainEmailListOpts {
  subject?: string
  fromAddr?: string
  mailbox?: string
  sinceDate?: string
  untilDate?: string
  isRead?: boolean
  isFlagged?: boolean
  limit?: number
  /** prd 07-27 C-1 — opt-in `exclude_drafts` (server default false). The tool passes true ONLY
   *  when no mailbox was requested, so a cross-mailbox list does not mix the user's own unsent
   *  drafts into "my mail" (the UI's /list-enriched already defaults to excluding them); an
   *  explicit mailbox (incl. 草稿箱) never sets it. undefined → param omitted → server default. */
  excludeDrafts?: boolean
  /** 🔴 0812 —— no gateway caller sets it any more (both Matter narrowings retired); kept as the
   *  typed mirror of the `matter_id` query param the Python endpoint still serves. */
  matterId?: number
}

/** Search filters for FTS (email_search_fulltext / email_search_attachments). */
export interface DomainSearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
  /** 🔴 0812 —— see DomainEmailListOpts.matterId: wire capability, currently no gateway producer. */
  matterId?: number
}

export interface DomainMatterMutation {
  source: string
  idempotency_key: string
  expected_version?: number
  reason?: string
  reverses_event_id?: number
}

export type DomainMatterResult = Record<string, unknown> & {
  undo?: { tool: string; input: Record<string, unknown>; label: string } | null
}

/** P4 — GET /matters/{id}/updates/{update_id}. Contracts §3.8 wraps the row in `update`; the type
 *  spells BOTH shapes because its one consumer (matter_review_update's approval seam) treats an
 *  unreadable payload as "ask" — a wrapper change must degrade to an extra approval card, never
 *  to a crash or to a silent card-free accept. */
export type DomainMatterUpdateDetail = Record<string, unknown> & {
  update?: Record<string, unknown>
  changes?: unknown
}

/** Filters for report_list. */
export interface DomainReportListOpts {
  cadence?: 'daily' | 'weekly' | 'monthly' | 'custom'
  agentId?: string
  limit?: number
}

/** email_search_attachments — one hit of GET /attachment/search (search batch2 PR-B, D4). */
export interface DomainAttachmentSearchHit {
  attachment_id: number
  internal_id: number
  filename: string
  content_type: string | null
  email_subject: string
  email_sender: string
  email_date: string | null
  email_mailbox: string | null
  snippet: string
  // batch3 PR-E: null for pure-LIKE trigram hits (2-char CJK / short-latin, no bm25);
  // a float for MATCH / unicode61 (smaller = more relevant).
  rank: number | null
  notion_page_id: string | null
  notion_url: string | null
}

/** GET /attachment/search data block (search batch2 PR-B, D4: has_more via a limit+1 probe
 *  on the route layer — repo signature unchanged). No parse_warnings: the endpoint runs no
 *  DSL parsing (plain FTS5 query / smart CJK rewrite only). */
export interface DomainAttachmentSearchResult {
  items: DomainAttachmentSearchHit[]
  total_indexed: number
  mode: 'smart' | 'raw'
  has_more: boolean
  transformed_query?: string
}

/** email_thread_attachments — one attachment row (metadata + owning-email provenance) of GET
 *  /attachment/thread/{thread_id}. is_inline=true is usually a signature image / inline graphic
 *  rather than a real document. */
export interface DomainThreadAttachmentItem {
  id: number
  internal_id: number
  filename: string
  size_bytes: number | null
  content_type: string | null
  is_inline: boolean
  sender: string | null
  sender_name: string | null
  date_received: string | null
  email_subject: string | null
}

/** GET /attachment/thread/{thread_id} data block. */
export interface DomainThreadAttachmentsResult {
  thread_id: string
  items: DomainThreadAttachmentItem[]
}

/** email_attachment_text — GET /attachment/{id}/text data block. `status` gates content:
 *  'extracted' → text_content present (already server-clipped, `truncated` flags a cut);
 *  'pending' | 'failed' | 'unsupported' → text_content null + a human-readable `hint`. */
export interface DomainAttachmentTextResult {
  attachment_id: number
  internal_id: number
  filename: string
  status: 'extracted' | 'pending' | 'failed' | 'unsupported'
  text_content: string | null
  truncated: boolean
  extractor: string | null
  email_subject: string | null
  sender: string | null
  hint: string | null
}

// ── write-endpoint shapes (Phase 03b) — mirror the legacy ChatToolPlatform data
//    blocks (shared/chat/tools/builtin/write.ts) byte-for-byte so a gateway write
//    tool's massaged output matches the legacy tool's (parity). ──────────────────

/** email_flag patch — only the provided fields go on the wire (mirrors HttpApi.flag). */
export interface DomainFlagPatch {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
}

/** POST /email/{id}/flag data block (FlagResult — the relevant subset the tool reads). */
export interface DomainFlagResult {
  updated_ids?: number[]
  outbox_entries?: unknown[]
  /** 🔴 set_flags is the ONE write op with a SOFT not-found (every other one raises 404):
   *  an internal_id that doesn't exist comes back HTTP 200 with the id listed here and
   *  NOTHING written. Python omits the key entirely when empty
   *  (`src/api/routers/email.py::_run_flag_service`, mirroring `MailWriteService` FlagResult),
   *  so absent ≠ "all applied" only because updated_ids is authoritative — read both. */
  not_found?: number[]
}

/** POST /email/{id}/archive | /move data block (Archive/MoveResult). */
export interface DomainArchiveResult {
  from_mailbox?: string | null
  to_mailbox?: string | null
  notion_updated?: boolean
}

/** POST /email/{id}/pin data block (PinResult). */
export interface DomainPinResult {
  is_pinned?: boolean
  changed?: boolean
}

/** POST /email/{id}/resync data block (ResyncResult). */
export interface DomainResyncResult {
  old_page_id?: string | null
  new_page_id?: string | null
  action?: string
}

/** Projected reply-draft result — mirrors HttpChatPlatform.draftReply's projection of
 *  the POST /email/draft data block ({internal_id, drafts_folder?, method?}). */
export interface DomainDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  draftId: string
}

/** POST /email/draft request body (prd 07-27) — the camelCase wire shape the renderer's composer
 *  posts (ComposeDraftOpts / serve-api `_compose_request_from_body`). One typed input for both
 *  new-draft tools; every optional key is omitted from the JSON when unset, so a call carries
 *  exactly the fields it means (an empty list is NOT "clear the list" — it is "no override").
 *  Recipients are string lists (the route joins them). */
export interface DomainComposeDraftInput {
  /** Source email ROWID; -1 = the mode-'new' sentinel (no source email). */
  internalId: number
  mode: 'new' | 'forward'
  /** Draft-edit linkage restore — MUST equal internalId (see composeDraft's note). */
  sourceDraftId?: number
  subject?: string
  /** Markdown/plain body (server converts to html). Mutually exclusive with bodyHtml in
   *  practice: the service prefers bodyHtml when both are present. */
  bodyText?: string
  /** Verbatim html body (an unchanged draft body carried over without a markdown round-trip). */
  bodyHtml?: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  /** forward: append the quoted original below the body (service `build_quote`). */
  quoteOriginal?: boolean
  /** Library attachment references to carry into the new draft ({attachment_id}). Absent →
   *  forward auto-collects the source email's attachments; present → authoritative list. */
  attachments?: Array<{ attachment_id: number }>
}

/** POST /email/draft data block (ComposeDraftResult). 🔴 `internal_id` echoes the REQUEST id —
 *  it is not the created draft's row id (see composeDraft). */
export interface DomainComposeDraftResult {
  internal_id: number
  drafts_folder?: string | null
  appended_uid?: number | null
  method?: string | null
  mode?: string | null
  to_count?: number
  cc_count?: number
  attachments?: number
  warnings?: string[]
}

/** DELETE /email/draft/{id} data block (DeleteDraftResult). */
export interface DomainDeleteDraftResult {
  internal_id?: number
  imap_uid?: number | null
  local_deleted?: boolean
}

/** POST /email/send-approved request body (Phase 04b). The outbound fields + the double-guard
 *  envelope (content hash + idempotency key + HMAC approval token + expiry) the Python guard
 *  re-verifies before a real SMTP send. */
export interface DomainSendApprovedRequest {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyText: string
  /** Optional source-email context (audit / threading); the send itself is a fresh 'new'
   *  compose using the explicit recipients/subject/body. -1 = no source. */
  internalId: number
  contentHash: string
  idempotencyKey: string
  approvalToken: string
  expiresAt: number
}

/** POST /email/send-approved data block (the relevant subset the tool reads). */
export interface DomainSendApprovedResult {
  sent?: boolean
  message_id?: string | null
  archived_to_sent?: boolean
  method?: string | null
  to_count?: number
  cc_count?: number
}

const LOCAL_TOKEN_HEADER = 'X-MailAgent-Local-Token'

function buildQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    // String(false) → 'false' / String(10) → '10' — the wire form serve-api expects.
    params.set(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/**
 * Typed HTTP client to the Python serve-api read endpoints. Each method maps one
 * tool's primitive to one endpoint, unwrapping the `{status, data, error}` envelope
 * (returns `data` on success/partial_failure, throws DomainError on `status:error`).
 */
/** M4b — one Standing Context doc (soul/agent/rules/user) from /agent/profile/docs/{name}.
 *  S1 R2: also the shape of GET (read) + rollback + the memory doc — `budgetChars` is present
 *  only for memory (its always-injected hard character budget); `updatedAt` is epoch ms on the
 *  wire (store `_now()` int). */
export interface DomainProfileDocResult {
  docName: string
  content: string
  contentHash: string
  updatedBy: string
  updatedAt: string | number | null
  editable: boolean
  budgetChars?: number
}

/** S1 R2 — one version-history entry from GET /agent/profile/history (newest first).
 *  `newHash` is the version identifier a rollback targets (targetHash). */
export interface DomainProfileHistoryEntry {
  id: number
  docName: string
  oldHash: string | null
  newHash: string
  changedBy: string
  sessionId: number | null
  messageId: number | null
  createdAt: number
}

/** M4c — one resolved skill from /agent/skills (discover_skills projection). */
export interface DomainResolvedSkill {
  name: string
  title: string
  description: string
  defaultEnabled: boolean
  enabled: boolean
  overridden: boolean
  available: boolean
  unavailableReason: string | null
  toolCount: number
  scopes: string[]
  sourceType: string
  /** issue #62 — absolute on-disk directory of a supply-chain installed skill (null for builtins). */
  installDir?: string | null
}

// ── session-read shapes (S1 R1) — the /chat/sessions/* rows the session tools consume.
//    snake_case mirrors the serve-api envelope data (src/chat/db.py rows). ────────────

/** chat_session_list — one row of GET /chat/sessions/all (ChatSessionSummary + email join). */
export interface DomainChatSessionSummary {
  id: number
  email_id: number | null
  anchor_type: string
  backend_kind: string
  title: string | null
  archived: number | boolean
  created_at: number
  updated_at: number
  first_user_message: string | null
  message_count: number
  origin?: string | null
  agent_id?: string | null
  agent_job_id?: string | null
  trigger_id?: string | null
  trigger_kind?: string | null
  trigger_fired_at?: number | null
  starred?: number | boolean
  run?: DomainSessionRun
  email_subject?: string | null
  email_sender?: string | null
}

/** chat_session_get — one row of GET /chat/sessions/{id}/messages (the subset the tool reads). */
export interface DomainChatMessage {
  id: number
  session_id: number
  role: string
  content: string
  model: string | null
  created_at: number
}

// ── web shapes (S1 R3) — the /web/* rows the web tools consume. Python (routers/web.py) is
//    the execution authority (SSRF guard + IP pinning); the client just carries the envelope. ──

/** web_fetch — data block of POST /web/fetch. `text` is the extracted (untrusted) content;
 *  the tool WEB_CONTENT-fences it before it reaches the model. */
export interface DomainWebFetchResult {
  url: string
  final_url: string
  status: number
  content_type: string | null
  title: string | null
  text: string
  truncated: boolean
}

/** web_search — data block of POST /web/search (DuckDuckGo, best-effort). */
export interface DomainWebSearchResult {
  query: string
  count: number
  results: Array<{ title: string; url: string; snippet: string }>
}

// ── notion-agent shape (task 07-21) — the /api/skills/invoke result of notion_agent_chat. The
//    notion-agent's answer text is externally-authored (an external AI + Notion content) → the
//    tool WRAPS it in an untrusted fence before the model sees it. thread_id is the continuation
//    token (server metadata; may be absent when the notion-agent returns none). ──
export interface DomainNotionAgentChatResult {
  final_content: string
  thread_id?: string | null
}

// ── MCP connector shapes (stage 1 PR2) — the /api/connector/* rows the dynamic connector tools
//    consume (tools/connector.ts). Python owns the MCP client + tool whitelist; these carry the
//    envelope only. ──

/** GET /api/connector data block (registry ∪ DB runtime state; the manifest seam only consumes
 *  the fields below). */
export interface DomainConnectorList {
  connectors: Array<{
    connector_id: string
    display_name: string | null
    status: string
    enabled: boolean
  }>
}

/** GET /api/connector/{id}/tools data block. `effective_mode` is the SERVER-folded per-tool
 *  tier (08-05 WP-10: 'auto' | 'ask' | 'off'; NULL override → 'auto' — the fold is never
 *  re-computed client-side); orphan rows are still listed (Q16=A manifest completeness) —
 *  registration skips them. */
export interface DomainConnectorTools {
  connector_id: string
  tools: Array<{
    name: string
    description: string
    input_schema_json: string | null
    crud_type: string
    destructive: boolean
    effective_mode: string
    orphan: boolean
  }>
}

/** POST /api/connector/{id}/tools/{name}/invoke data block. `content` is already truncated
 *  server-side (truncated tells the model); the fence (UNTRUSTED_MCP_TOOL) is applied by the
 *  gateway tool, not here. */
export interface DomainConnectorInvokeResult {
  connector_id: string
  tool_name: string
  content: string
  is_error: boolean
  truncated: boolean
  elapsed_ms: number
}

// ── exec shapes (S2 W1) — the /api/exec/* rows the run_command/file_read/file_write tools consume.
//    Python (routers/exec.py) is the execution authority (fixed env allowlist, inode-level deny
//    floor, no shell); the client just carries the envelope. `policy` is an AUDIT verdict only
//    (the exec endpoint does NOT gate — the gateway needsApproval already decided via /evaluate). ──

/** POST /api/exec/run data block. floor_hit is INFORMATIONAL (a sensitive argv/cwd flagged, run
 *  NOT blocked — run_command has no filesystem sandbox); floor_hits are human-readable reasons. */
export interface DomainExecRunResult {
  exit_code: number
  stdout: string
  stderr: string
  truncated: boolean
  duration_ms: number
  cwd: string
  floor_hit: boolean
  floor_hits: string[]
  /** W4 security disclosure — the per-skill secret NAMES this run overlaid onto the child
   *  process env (values never cross the wire). Built for the approval card
   *  (`routers/exec.py:509`) but dropped by this type, so the owner never learned which of
   *  their stored secrets a command could read. Post-run by construction: the overlay is
   *  resolved inside /exec/run, after the skill probe — there is no preview endpoint. */
  injected_secret_names: string[]
  /** W4 first-run gate — skill entrypoints this run recorded as approved-for-first-run. */
  first_run_recorded: string[]
  policy: { decision: 'auto_allow' | 'ask'; rule_id: number | null }
}

/** POST /api/exec/file_read data block. */
export interface DomainExecFileReadResult {
  content: string
  truncated: boolean
  size: number
  policy: { decision: 'auto_allow' | 'ask'; rule_id: number | null }
}

/** POST /api/exec/file_write data block. */
export interface DomainExecFileWriteResult {
  bytes_written: number
  created: boolean
  policy: { decision: 'auto_allow' | 'ask'; rule_id: number | null }
}

/** POST /api/agent/policy/evaluate verdict (a structured whitelist decision the gateway
 *  needsApproval consults BEFORE showing an exec approval card). auto_allow → skip the card;
 *  ask (no match / any error, fail-closed) → show the card. */
export interface DomainPolicyVerdict {
  decision: 'auto_allow' | 'ask'
  rule_id: number | null
  /** L4 群聊 g2 adds 'auto_judge_scope' (judge run, judgeScopeHash matched) and
   *  'auto_user_requested_verified' (main agent, server-verified last human message) — both are
   *  produced by the in-process group factories (tools/groups.ts), never by serve-api. */
  audit_status?:
    | 'auto_user_requested'
    | 'auto_delegation_readonly'
    | 'auto_judge_scope'
    | 'auto_user_requested_verified'
}

/** L4 群聊 g2 — POST /chat/sessions/new data block of a GROUP session (the subset group_create
 *  reads back). A subgroup echoes back its parent_session_id / invoked_by; a top-level group
 *  carries null for both. */
export interface DomainGroupSessionCreated {
  id: number
  title: string | null
  members_json: string
  parent_session_id?: number | null
  invoked_by?: string | null
}

export interface DomainAgentCallEnqueueResult {
  jobId: number
  wasCreated: boolean
  sessionId: number
}

export interface DomainAgentRunDetail extends AgentRunHistoryItem {
  agentTitle: string
  finalAnswer?: string | null
  finalAnswerTruncated?: boolean
}

/** One PolicyRule (camelCase, GET/POST /api/agent/policy/rules). `dangerous` = a wide interpreter
 *  rule (UI shows a red not-a-sandbox warning). matcher is the structured typed matcher. */
export interface DomainPolicyRule {
  id: number
  capability: string
  matcher: Record<string, unknown>
  contextMode: string
  agentId: number | null
  enabled: boolean
  note: string | null
  createdAt: string
  lastUsedAt: string | null
  useCount: number
  dangerous: boolean
}

// ── skill-supply shapes (S2 W4) — the /agent/skills/{fetch,confirm,uninstall} + /doc rows the
//    skill_install / skill_install_confirm / skill_uninstall / skill_read tools consume. Python
//    (routers/agent.py + skills/pack_fetch|pack_verify) is the business authority: SSRF-hardened
//    download, safe unpack, REAL hashes, and the confirm-time re-hash TOCTOU guard. The client
//    just carries the envelope; manifest title/description + skillMdExcerpt are third-party text
//    the TOOL sanitizes/fences before they reach the model (ADR-002 D4). ────────────────────────

/** POST /agent/skills/fetch preview (also the GET /agent/skills/quarantine/{qid} facts shape).
 *  `files` is {relpath: sha256} — echoed VERBATIM into confirm as expectedFiles (byte-exact,
 *  the server compares re-computed hashes against it). */
export interface DomainSkillFetchPreview {
  quarantineId: string
  sourceType: string | null
  sourceUri: string | null
  packageHash: string
  files: Record<string, string>
  manifest: {
    name: string | null
    type: string | null
    version: string | null
    title: string | null
    description: string | null
    entryHint: string | null
    manifestVersion: number | string | null
  }
  secretNames: string[]
  skillMdExcerpt: string
}

export interface DomainSkillDraft {
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

/** POST /agent/skills/confirm data block (the row landed + content promoted). */
export interface DomainSkillConfirmResult {
  name: string
  sourceType: string
  packageHash: string
}

/** POST /agent/skills/uninstall data block (full cleanup: row + dir + secrets). */
export interface DomainSkillUninstallResult {
  name: string
  removed: boolean
  removedDir: boolean
  removedSecrets: number
}

/** GET /agent/skills/{name}/doc data block — the RAW SKILL.md (server caps at 64KB; the tool
 *  fences + truncates to 32KB before the model sees it). `installDir` (issue #62) is the skill's
 *  ABSOLUTE on-disk directory, supplied by Python so TS never hand-copies the skills root. */
export interface DomainSkillDocResult {
  name: string
  content: string
  truncated: boolean
  installDir?: string | null
  /** 阶段 0.5 — 'builtin' = a code-owned skill doc (no install dir, no scripts to run); 'installed'
   *  = a third-party package on disk. ABSENT on an older server — never infer builtin-ness from a
   *  null installDir, which that older server also produced for installed skills. */
  source?: 'builtin' | 'installed'
}

/** chat_session_search — one aggregated hit of GET /chat/sessions/search. */
export interface DomainSessionSearchHit {
  session: {
    id: number
    email_id: number | null
    anchor_type: string
    backend_kind: string
    title: string | null
    archived: number | boolean
    created_at: number
    updated_at: number
  }
  snippets: Array<{
    message_id: number
    role: string
    snippet: string
    created_at: number
  }>
  run?: DomainSessionRun
}

export interface DomainSessionRun {
  state: string
  outcome?: string | null
  approvalState?: string | null
  finishedAt?: number | null
  error?: string | null
}

export interface DomainSessionQuery {
  origin?: 'interactive' | 'agent' | 'im' | 'all'
  agentId?: string
  agentJobId?: string
  triggerId?: string
  triggerKind?: string
  createdAfter?: number
  createdBefore?: number
  archived?: boolean
  starred?: boolean
  limit?: number
}

/** 资料库 P2-L1 — who is writing, in the router's own vocabulary (routers/library.py::ActorSpec,
 *  `extra="forbid"` — nothing else may ride along): the main assistant, or a custom agent with
 *  its agent_id. A request with NO actor is the renderer (= user); the gateway always sends one,
 *  and Python jails the write on it (custom agent → agent-docs/ only, main agent also my-docs/). */
export interface DomainLibraryActor {
  kind: 'main_agent' | 'custom_agent'
  agentId?: string
}

function libraryActorWire(actor: DomainLibraryActor): Record<string, unknown> {
  return {
    kind: actor.kind,
    ...(actor.agentId !== undefined ? { agent_id: actor.agentId } : {})
  }
}

export class MailAgentDomainClient {
  private readonly baseUrl: string
  private readonly localToken: string | null
  private readonly fetchImpl: typeof fetch

  constructor(config: DomainClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.localToken = config.localToken
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /** Core request: build URL + query, inject the local token, parse the envelope. */
  private async _req<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, QueryValue>
      body?: unknown
      signal?: AbortSignal
      /** Extra request headers (e.g. S4's X-Claim-Token). Merged after the Accept / local-token /
       *  Content-Type defaults; a caller-supplied key overrides a default. */
      headers?: Record<string, string>
    }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${opts?.query ? buildQuery(opts.query) : ''}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.localToken) headers[LOCAL_TOKEN_HEADER] = this.localToken
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts?.headers) Object.assign(headers, opts.headers)

    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal
      })
    } catch (e) {
      // Network failure / abort. Re-throw abort as-is (AI SDK / caller distinguishes
      // it); other fetch failures become a typed E_NETWORK DomainError.
      if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) throw e
      throw new DomainError('E_NETWORK', e instanceof Error ? e.message : String(e))
    }

    let parsed: unknown
    try {
      parsed = await resp.json()
    } catch {
      // Non-JSON body. If the status was an error, synthesize one; success non-JSON
      // shouldn't happen for these envelope endpoints.
      if (!resp.ok) {
        throw new DomainError('E_UPSTREAM', `serve-api ${resp.status} (non-JSON body)`, {
          httpStatus: resp.status
        })
      }
      throw new DomainError('E_SCHEMA_MISMATCH', 'serve-api returned a non-JSON success body')
    }

    const envelope = parsed as {
      status?: string
      data?: unknown
      error?: { code?: string; message?: string; hint?: string }
    }
    if (envelope.status === 'success' || envelope.status === 'partial_failure') {
      return envelope.data as T
    }
    // status:error (or missing/unknown status) → typed DomainError. An error envelope's `data` is
    // null everywhere except the library CAS 409 (routers/library.py::_conflict_response puts
    // {content_hash, content} there) — surfaced as DomainError.data, undefined when null.
    const err = envelope.error ?? {}
    throw new DomainError(err.code ?? 'E_UPSTREAM', err.message ?? `serve-api ${resp.status}`, {
      hint: err.hint,
      httpStatus: resp.status,
      data: envelope.data ?? undefined
    })
  }

  // ── read primitives (one per gateway read tool) ──────────────────────────

  /** email_list_filter — metadata-filter list. GET /email/list (camelCase alias query).
   *  🔴 `exclude_drafts` is snake_case on purpose — it is the ONE key of this endpoint that is
   *  not a camelCase alias (prd 07-27 C-1 cross-lane contract); FastAPI would silently drop an
   *  `excludeDrafts` and the drafts would quietly return to the model's results. */
  searchEmails(
    opts: DomainEmailListOpts,
    signal?: AbortSignal
  ): Promise<EmailList_EmailListItem[]> {
    return this._req<EmailList_EmailListItem[]>('GET', '/email/list', {
      query: {
        subject: opts.subject,
        fromAddr: opts.fromAddr,
        mailbox: opts.mailbox,
        sinceDate: opts.sinceDate,
        untilDate: opts.untilDate,
        isRead: opts.isRead,
        isFlagged: opts.isFlagged,
        exclude_drafts: opts.excludeDrafts,
        matter_id: opts.matterId,
        limit: opts.limit
      },
      signal
    })
  }

  listMatters(
    opts: {
      q?: string
      status?: string
      health?: string
      priority?: string
      type?: string
      tag?: string
      view?: string
      archived?: boolean
      deleted?: boolean
      limit?: number
    },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor?: string | null }> {
    return this._req('GET', '/matters', { query: opts, signal })
  }

  getMatter(
    publicId: string,
    include: readonly string[],
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req('GET', `/matters/${encodeURIComponent(publicId)}`, {
      query: { include: include.join(',') },
      signal
    })
  }

  createMatter(
    data: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('POST', '/matters', { body: { ...data, mutation }, signal })
  }

  updateMatter(
    publicId: string,
    operation: 'patch' | 'archive' | 'reopen' | 'trash' | 'restore',
    patch: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const path = `/matters/${encodeURIComponent(publicId)}`
    if (operation === 'patch') {
      return this._req('PATCH', path, { body: { ...(patch ?? {}), mutation }, signal })
    }
    return this._req('POST', `${path}/${operation}`, { body: { mutation }, signal })
  }

  /** task 08-14 — 跟进配置的逐条编辑。`payload` 按 operation 各吃各的键，语义权威在 Python
   *  （src/matters/followup_config.py → triggers.py 归一）；这里只做透传，不在 TS 侧复刻一份
   *  envelope 逻辑。 */
  mutateMatterFollowup(
    publicId: string,
    operation: string,
    payload: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('PATCH', `/matters/${encodeURIComponent(publicId)}/followup`, {
      body: { operation, payload, mutation },
      signal
    })
  }

  mutateMatterItem(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    itemId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/items`
    if (operation === 'create')
      return this._req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const itemPath = `${base}/${itemId}`
    if (operation === 'update')
      return this._req('PATCH', itemPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete') return this._req('DELETE', itemPath, { body: { mutation }, signal })
    return this._req('POST', `${itemPath}/restore`, { body: { mutation }, signal })
  }

  /** task 08-25 — curated 进展条目的逐条写。路径形状与 items 逐字一致（POST / PATCH /
   *  DELETE / POST …/restore），语义权威在 Python。 */
  mutateMatterProgress(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    progressId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/progress`
    if (operation === 'create')
      return this._req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const progressPath = `${base}/${progressId}`
    if (operation === 'update')
      return this._req('PATCH', progressPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return this._req('DELETE', progressPath, { body: { mutation }, signal })
    return this._req('POST', `${progressPath}/restore`, { body: { mutation }, signal })
  }

  mutateMatterResource(
    publicId: string,
    operation: 'link' | 'update' | 'unlink' | 'restore',
    resourceId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/resources`
    if (operation === 'link')
      return this._req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const resourcePath = `${base}/${resourceId}`
    if (operation === 'update')
      return this._req('PATCH', resourcePath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'unlink')
      return this._req('DELETE', resourcePath, { body: { mutation }, signal })
    return this._req('POST', `${resourcePath}/restore`, { body: { mutation }, signal })
  }

  mutateMatterStakeholder(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    stakeholderId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/stakeholders`
    if (operation === 'create')
      return this._req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const stakeholderPath = `${base}/${stakeholderId}`
    if (operation === 'update')
      return this._req('PATCH', stakeholderPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return this._req('DELETE', stakeholderPath, { body: { mutation }, signal })
    return this._req('POST', `${stakeholderPath}/restore`, { body: { mutation }, signal })
  }

  mutateMatterRelation(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    relationId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/relations`
    if (operation === 'create')
      return this._req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const relationPath = `${base}/${relationId}`
    if (operation === 'update')
      return this._req('PATCH', relationPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return this._req('DELETE', relationPath, { body: { mutation }, signal })
    return this._req('POST', `${relationPath}/restore`, { body: { mutation }, signal })
  }

  addMatterNote(
    publicId: string,
    data: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('POST', `/matters/${encodeURIComponent(publicId)}/notes`, {
      body: { ...data, mutation },
      signal
    })
  }

  // ── 0813 轮 3 批 R — the four surfaces that had REST but no tool ─────────────────────────────

  /** GET /matters/attention (all Matters) or /matters/{id}/attention (one). Same service call
   *  behind both; the path is what scopes it. */
  listMatterAttention(
    opts: { publicId?: string; state?: string },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const path =
      opts.publicId != null
        ? `/matters/${encodeURIComponent(opts.publicId)}/attention`
        : '/matters/attention'
    return this._req('GET', path, { query: { state: opts.state }, signal })
  }

  /** POST /matters/{id}/attention/{signal_id}/{resolve|snooze|dismiss}.
   *  🔴 The action is a PATH segment, so it is encoded here rather than posted as data — a
   *  mis-spelled action 404s at the router instead of silently taking a default branch. */
  triageMatterAttention(
    publicId: string,
    signalId: number,
    action: 'resolve' | 'snooze' | 'dismiss',
    payload: { until?: number },
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/attention/${signalId}/${action}`,
      { body: { ...payload, mutation }, signal }
    )
  }

  /** GET /matters/{id}/runs — the follow-up run ledger. Gated server-side by the matter-agent
   *  flag (409/403 when it is off), which is why the tool is only registered when that flag is on. */
  listMatterRuns(
    publicId: string,
    opts: { limit?: number },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor?: number | null }> {
    return this._req('GET', `/matters/${encodeURIComponent(publicId)}/runs`, {
      query: { limit: opts.limit },
      signal
    })
  }

  /** GET /matters/tags — the tag vocabulary (name + color/shape + usage_count). */
  listMatterTags(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>> }> {
    return this._req('GET', '/matters/tags', { signal })
  }

  /** POST /matters/{id}/resource-suggestions/bulk — confirm or reject unconfirmed suggestions in
   *  ONE version check + ONE version bump. Always 200: ids that were already handled elsewhere
   *  come back per-row in `skipped`, they do not fail the batch. */
  resolveMatterSuggestions(
    publicId: string,
    resourceIds: readonly number[],
    action: 'confirm' | 'reject',
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('POST', `/matters/${encodeURIComponent(publicId)}/resource-suggestions/bulk`, {
      body: { resource_ids: resourceIds, action, mutation },
      signal
    })
  }

  // ── Matters MVP P4 — follow-up runs, proposals, review (contracts §3.8/§3.9) ───────────────
  //
  // 🔴 `proposeMatterUpdate` targets the INTERNAL proposal endpoint (verify_local_token + the
  // matters/agent double flag gate, never the cf_access face): only the gateway, running a
  // server-assembled matter_followup spec, can reach it. The matter/run identity comes from the
  // path — the tool's input carries neither (D6).

  /** POST /matters/{public_id}/runs/{run_id}/proposal — the follow-up run's single write.
   *  409 E_PROPOSAL_EXISTS when this run already submitted one (at most one proposal per run). */
  proposeMatterUpdate(
    publicId: string,
    runId: number,
    proposal: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req('POST', `/matters/${encodeURIComponent(publicId)}/runs/${runId}/proposal`, {
      body: proposal,
      signal
    })
  }

  /** POST /matters/{public_id}/item-dispatches/{dispatch_id}/report — an ITEM-dispatch run's
   *  single delivery (L4 批次3). Same INTERNAL face as proposeMatterUpdate above
   *  (verify_local_token, gateway-only): the matter + dispatch identity comes from the path, the
   *  tool's input carries neither. Either a result (summary/changes → a pending proposal) or a
   *  question (needs_input → the dispatch waits on the owner); Python enforces the one-of-two and
   *  409s a second delivery for the same attempt. */
  reportItemDispatch(
    publicId: string,
    dispatchId: number,
    report: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/item-dispatches/${dispatchId}/report`,
      { body: report, signal }
    )
  }

  /** POST /matters/{public_id}/runs — start a manual follow-up run. `trigger_kind` is NOT part of
   *  the request: 'manual' is the only kind this face produces (contracts §4.4 — a schedule start
   *  is the scheduler's own internal path). An already-active run returns 200 + coalesced:true. */
  startMatterRun(
    publicId: string,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('POST', `/matters/${encodeURIComponent(publicId)}/runs`, {
      body: { mutation },
      signal
    })
  }

  /** POST /matters/{public_id}/runs/{run_id}/cancel — CAS cancel (queued → canceled outright;
   *  running → a cooperative cancel request). Never rolls back what the run already observed. */
  cancelMatterRun(
    publicId: string,
    runId: number,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req('POST', `/matters/${encodeURIComponent(publicId)}/runs/${runId}/cancel`, {
      body: { mutation },
      signal
    })
  }

  /** GET /matters/{public_id}/updates/{update_id} — the full proposal (original + changes +
   *  citations + reviewed result). Consumed by matter_review_update's dynamic approval seam to
   *  decide whether the SELECTED changes touch a `field` (→ approval card). */
  getMatterUpdate(
    publicId: string,
    updateId: number,
    signal?: AbortSignal
  ): Promise<DomainMatterUpdateDetail> {
    return this._req('GET', `/matters/${encodeURIComponent(publicId)}/updates/${updateId}`, {
      signal
    })
  }

  /** POST /matters/{public_id}/updates/{update_id}/accept|reject — the owner's review decision.
   *  accept applies the selected (optionally edited) changes in ONE transaction and bumps the
   *  Matter version exactly once; reject applies nothing but still records the decision. */
  reviewMatterUpdate(
    publicId: string,
    updateId: number,
    decision: 'accept' | 'reject',
    payload: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return this._req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/updates/${updateId}/${decision}`,
      { body: { ...payload, mutation }, signal }
    )
  }

  /** email_search_fulltext — FTS body search. GET /email/search (param is `q`). */
  searchEmailsFulltext(opts: DomainSearchOpts, signal?: AbortSignal): Promise<SearchResult> {
    return this._req<SearchResult>('GET', '/email/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
        matter_id: opts.matterId
      },
      signal
    })
  }

  /** email_get — single email metadata. GET /email/{id}?include=attachments.
   *  E_NOT_FOUND → null (mirrors httpApi.email.get).
   *
   *  `matterScope` (internal int matter id) is the SERVER-side membership guard: when present the
   *  endpoint verifies internal_id ∈ that Matter's access_policy='allowed' resource set and 403s
   *  E_MATTER_SCOPE otherwise. 🔴 0812 owner拍板 —— NO gateway caller passes it any more (the
   *  follow-up run's anchor narrowing and the manual 事项对话 检索范围 toggle were both retired,
   *  see tools/email.ts). Kept as the typed mirror of a query param the Python endpoint still
   *  serves and still tests; it is a wire capability, not tool plumbing. */
  async getEmail(
    internalId: number,
    signal?: AbortSignal,
    matterScope?: number
  ): Promise<EmailGet_EmailRecord | null> {
    try {
      return await this._req<EmailGet_EmailRecord>('GET', `/email/${internalId}`, {
        query: { include: 'attachments', matter_scope: matterScope },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** email_body — body in one format. GET /email/{id}/body?format=markdown (default) | html.
   *  E_NOT_FOUND → null (mirrors httpApi.email.body; the endpoint 404s both for "no body row"
   *  and "that format column is null", so an html miss degrades to null, not a throw).
   *  `format` is only ever passed by email_draft_update, which re-posts an unchanged draft body
   *  VERBATIM as html — a markdown round-trip would silently flatten tables / styling. */
  async getEmailBody(
    internalId: number,
    signal?: AbortSignal,
    format: 'markdown' | 'html' = 'markdown'
  ): Promise<NonNullable<MailagentEmailBody['data']> | null> {
    try {
      return await this._req<NonNullable<MailagentEmailBody['data']>>(
        'GET',
        `/email/${internalId}/body`,
        { query: { format }, signal }
      )
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** email_list_thread — sibling emails by thread_id. GET /email/thread/{tid}. */
  listEmailsByThread(threadId: string, signal?: AbortSignal): Promise<EmailList_EmailListItem[]> {
    return this._req<EmailList_EmailListItem[]>(
      'GET',
      `/email/thread/${encodeURIComponent(threadId)}`,
      { signal }
    )
  }

  /** email_search_attachments — FTS over extracted attachment text. GET /attachment/search
   *  (param is `q`). */
  searchAttachments(
    opts: DomainSearchOpts,
    signal?: AbortSignal
  ): Promise<DomainAttachmentSearchResult> {
    return this._req<DomainAttachmentSearchResult>('GET', '/attachment/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit
      },
      signal
    })
  }

  /** email_thread_attachments — every attachment across a thread (metadata + owning-email
   *  provenance). GET /attachment/thread/{thread_id}. The endpoint returns {thread_id, items}. */
  threadAttachments(
    threadId: string,
    signal?: AbortSignal
  ): Promise<DomainThreadAttachmentsResult> {
    return this._req<DomainThreadAttachmentsResult>(
      'GET',
      `/attachment/thread/${encodeURIComponent(threadId)}`,
      { signal }
    )
  }

  /** email_attachment_text — extracted text of one attachment (server clips to max_chars and
   *  reports `truncated`). GET /attachment/{id}/text?max_chars=N. Non-extracted statuses
   *  (pending/failed/unsupported) return text_content=null + a `hint`. */
  attachmentText(
    attachmentId: number,
    maxChars: number,
    signal?: AbortSignal
  ): Promise<DomainAttachmentTextResult> {
    return this._req<DomainAttachmentTextResult>('GET', `/attachment/${attachmentId}/text`, {
      query: { max_chars: maxChars },
      signal
    })
  }

  /** kos_query — KOS tool proxy. POST /chat/kos-call {name, args}. Returns the raw
   *  KOS result (list/dict/str). E_KOS_* errors surface as DomainError. */
  kosCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this._req<unknown>('POST', '/chat/kos-call', { body: { name, args }, signal })
  }

  /** report_list — generated reports. GET /reports (agentId alias). */
  listReports(opts: DomainReportListOpts, signal?: AbortSignal): Promise<ReportListItem[]> {
    return this._req<ReportListItem[]>('GET', '/reports', {
      query: { cadence: opts.cadence, agentId: opts.agentId, limit: opts.limit },
      signal
    })
  }

  /** report_get — one report incl. doc blocks. GET /reports/{id}.
   *  E_NOT_FOUND → null (mirrors httpApi.report.get). */
  async getReport(reportId: string, signal?: AbortSignal): Promise<ReportDetail | null> {
    try {
      return await this._req<ReportDetail>('GET', `/reports/${encodeURIComponent(reportId)}`, {
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** report_write — persist a local custom ReportDoc artifact. */
  writeCustomReport(
    agentId: string,
    input: { title: string; blocks: ReportBlock[]; mode: 'new' | 'replace' },
    signal?: AbortSignal
  ): Promise<ReportDetail> {
    return this._req<ReportDetail>('POST', '/reports/custom', {
      body: { agentId, ...input },
      signal
    })
  }

  // ── write primitives (Phase 03b — one per gateway write tool) ─────────────
  // Each mirrors the legacy HttpChatPlatform write method's exact wire call
  // (body shape + path) so the gateway write tool is byte-for-byte parity with
  // the legacy tool over the same serve-api endpoint. The Python MailWriteService
  // remains the authoritative validator (二次鉴权): davmail-only checks, ai-field
  // enum/mailbox subset, outbox SSoT — the gateway approval guard is additive.

  /** email_flag — toggle is_read/is_flagged/processing_status. POST /email/{id}/flag.
   *  Only provided fields go on the wire (mirrors HttpApi.flag single mode). */
  flagEmail(
    internalId: number,
    patch: DomainFlagPatch,
    signal?: AbortSignal
  ): Promise<DomainFlagResult> {
    const body: Record<string, unknown> = {}
    if (patch.isRead !== undefined) body.isRead = patch.isRead
    if (patch.isFlagged !== undefined) body.isFlagged = patch.isFlagged
    if (patch.processingStatus !== undefined) body.processingStatus = patch.processingStatus
    return this._req<DomainFlagResult>('POST', `/email/${internalId}/flag`, { body, signal })
  }

  /** email_archive — IMAP MOVE INBOX→Archive + Mailbox→存档. POST /email/{id}/archive. */
  archiveEmail(internalId: number, signal?: AbortSignal): Promise<DomainArchiveResult> {
    return this._req<DomainArchiveResult>('POST', `/email/${internalId}/archive`, {
      body: {},
      signal
    })
  }

  /** email_pin — pin/unpin (local UI flag). POST /email/{id}/pin {pinned}. */
  setPin(internalId: number, pinned: boolean, signal?: AbortSignal): Promise<DomainPinResult> {
    return this._req<DomainPinResult>('POST', `/email/${internalId}/pin`, {
      body: { pinned },
      signal
    })
  }

  /** email_resync — re-push to Notion from the SQLite SSoT. POST /email/{id}/resync. */
  resyncEmail(internalId: number, signal?: AbortSignal): Promise<DomainResyncResult> {
    return this._req<DomainResyncResult>('POST', `/email/${internalId}/resync`, {
      body: {},
      signal
    })
  }

  /** email_draft_reply — create a reply / reply-all draft (davmail IMAP APPEND). POST
   *  /email/draft with {internalId, mode, bodyText, quoteOriginal:true} — mode defaults to
   *  'reply-all'; when opts.to/cc/bcc are present they ride along as FULL recipient-list
   *  overrides (serve-api _compose_request_from_body → service to_override; absent = the
   *  server derives them). Projects the data block exactly like the legacy
   *  HttpChatPlatform.draftReply so the tool's massage matches the legacy tool. */
  async draftReply(
    internalId: number,
    bodyMarkdown: string,
    opts: {
      mode?: 'reply' | 'reply-all'
      to?: string[]
      cc?: string[]
      bcc?: string[]
      signal?: AbortSignal
    } = {}
  ): Promise<DomainDraftResult> {
    const data = await this._req<{
      internal_id: number
      drafts_folder?: string | null
      method?: string | null
    }>('POST', '/email/draft', {
      body: {
        internalId,
        mode: opts.mode ?? 'reply-all',
        bodyText: bodyMarkdown,
        quoteOriginal: true,
        ...(opts.to?.length ? { to: opts.to } : {}),
        ...(opts.cc?.length ? { cc: opts.cc } : {}),
        ...(opts.bcc?.length ? { bcc: opts.bcc } : {})
      },
      signal: opts.signal
    })
    return {
      internalId: data.internal_id,
      mailbox: data.drafts_folder ?? null,
      accountName: null,
      draftId: data.method ?? 'reply_all'
    }
  }

  /** email_draft_compose / email_draft_update (prd 07-27 C-3/C-4) — create a draft through the
   *  SAME endpoint the renderer's composer uses (POST /email/draft). ONE wire method for both
   *  tools so the (camelCase) body key names are pinned in exactly one place:
   *    - compose new  → {internalId:-1 (sentinel — the route relaxes its non-negative check for
   *      mode 'new'), mode:'new', subject, to/cc/bcc, bodyText}
   *    - compose fwd  → {internalId:<source>, mode:'forward', quoteOriginal, …} (the service
   *      auto-collects the source email's attachments when no `attachments` key is sent)
   *    - update       → {internalId:<draft>, mode:'new', sourceDraftId:<the SAME draft id>, …}
   *      🔴 sourceDraftId MUST equal internalId — mail_write._prepare_draft rejects any other
   *      pairing (binding check) and silently falls back to zero thread derivation, i.e. the
   *      edited draft would lose its In-Reply-To/References. The renderer sends both keys with
   *      the same id for exactly this reason (ComposePanel.buildComposePayload).
   *  Returns the endpoint's data block verbatim (snake_case, like the other write primitives).
   *  🔴 The response `internal_id` is an ECHO of the request's id, NOT the new draft's row id
   *  (the row is allocated by _mirror_draft_locally and never returned) — callers must not
   *  present it as "the new draft". */
  composeDraft(
    input: DomainComposeDraftInput,
    signal?: AbortSignal
  ): Promise<DomainComposeDraftResult> {
    return this._req<DomainComposeDraftResult>('POST', '/email/draft', {
      body: {
        internalId: input.internalId,
        mode: input.mode,
        ...(input.sourceDraftId !== undefined ? { sourceDraftId: input.sourceDraftId } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.bodyHtml ? { bodyHtml: input.bodyHtml } : {}),
        ...(input.bodyText ? { bodyText: input.bodyText } : {}),
        ...(input.quoteOriginal !== undefined ? { quoteOriginal: input.quoteOriginal } : {}),
        ...(input.to?.length ? { to: input.to } : {}),
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.bcc?.length ? { bcc: input.bcc } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      },
      signal
    })
  }

  /** email_draft_update step 3 — delete the superseded draft. DELETE /email/draft/{id}
   *  (IMAP \Deleted+EXPUNGE + local row cleanup). davmail-only; the endpoint itself refuses a
   *  row whose mailbox is not the Drafts folder (E_INVALID_ARG). */
  deleteDraft(internalId: number, signal?: AbortSignal): Promise<DomainDeleteDraftResult> {
    return this._req<DomainDeleteDraftResult>('DELETE', `/email/draft/${internalId}`, { signal })
  }

  /** email_prepare_send (Phase 04b) — real SMTP send AFTER the double guard. POST
   *  /email/send-approved with the outbound fields + content hash + idempotency key + HMAC
   *  approval token + expiry. The Python guard verifies the token signature / expiry, recomputes
   *  the payload hash, checks the idempotency send ledger, and confirms the backend supports
   *  send — then sends. Any guard failure → DomainError (the email is never sent). */
  sendApproved(
    req: DomainSendApprovedRequest,
    signal?: AbortSignal
  ): Promise<DomainSendApprovedResult> {
    return this._req<DomainSendApprovedResult>('POST', '/email/send-approved', {
      body: {
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        bodyText: req.bodyText,
        internalId: req.internalId,
        contentHash: req.contentHash,
        idempotencyKey: req.idempotencyKey,
        approvalToken: req.approvalToken,
        expiresAt: req.expiresAt
      },
      signal
    })
  }

  /** M1 auto-capture — fire a finished turn at the mem0 extraction endpoint. POST
   *  /chat/memory/capture {userText, assistantText, sessionId?}. Returns the captured-entry
   *  summary; the caller (lifecycle, fire-and-forget) ignores it. INDEPENDENT from the
   *  agent_memory_kv layer (now retired). sessionId (provenance) only goes on the wire when it is a real number. */
  captureMemory(
    input: { userText: string; assistantText: string; sessionId?: number | null },
    signal?: AbortSignal
  ): Promise<{ captured: unknown[]; count: number }> {
    const body: Record<string, unknown> = {
      userText: input.userText,
      assistantText: input.assistantText
    }
    if (typeof input.sessionId === 'number') body.sessionId = input.sessionId
    return this._req<{ captured: unknown[]; count: number }>('POST', '/chat/memory/capture', {
      body,
      signal
    })
  }

  // ── session-read primitives (S1 R1) — the chat-session tools read the SAME ai_chat.db the
  //    gateway persists into, but through serve-api /chat/sessions/* (never SQLite directly):
  //    remote parity for free + the gateway core stays chat_db-free (纯核纪律). The tools that
  //    call these are only registered when MAILAGENT_OPENNESS_SESSION_TOOLS is on.

  /** chat_session_list — recent sessions incl. preview + message_count. GET /chat/sessions/all
   *  (fixed server-side cap 300; the tool slices to its own limit). */
  listSessions(
    query?: DomainSessionQuery,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainChatSessionSummary[]> {
    return this._req<DomainChatSessionSummary[]>('GET', '/chat/sessions/all', {
      query: query
        ? {
            origin: query.origin,
            agentId: query.agentId,
            agentJobId: query.agentJobId,
            triggerId: query.triggerId,
            triggerKind: query.triggerKind,
            createdAfter: query.createdAfter,
            createdBefore: query.createdBefore,
            archived: query.archived,
            starred: query.starred,
            limit: query.limit
          }
        : undefined,
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  /** chat_session_search — FTS (trigram) message search aggregated by session. GET
   *  /chat/sessions/search (param is `q`; <3-char queries LIKE-fallback server-side). */
  searchSessions(
    query: string,
    filters?: DomainSessionQuery,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainSessionSearchHit[]> {
    return this._req<DomainSessionSearchHit[]>('GET', '/chat/sessions/search', {
      query: { q: query, ...filters },
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  /** chat_session_get — all messages of one session (chronological). GET
   *  /chat/sessions/{id}/messages. Missing session → [] (the endpoint reads gracefully); an
   *  out-of-scope session under an own-radius `scope` → E_NOT_FOUND (server-enforced, same
   *  headers as list/search). */
  getSessionMessages(
    sessionId: number,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainChatMessage[]> {
    return this._req<DomainChatMessage[]>('GET', `/chat/sessions/${sessionId}/messages`, {
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  // ── group-session write primitives (L4 群聊 g2) — the ONLY serve-api writes of the group tool
  //    family (tools/groups.ts): history / members / deliveries go through the in-process cfg
  //    hooks, building a group and applying its config go here so the authoritative validation
  //    (chat-capable members / MAX_GROUP_MEMBERS / subgroup ⊆ parent / single-level nesting)
  //    stays in routers/chat.py — the gateway never mirrors it (红线 5).

  /** group_create step 1 — POST /chat/sessions/new with groupMembers (恒 general anchor).
   *  parentSessionId (subgroup) / invokedBy ('main_agent' | 'judge') only go on the wire when
   *  present; a 4xx (non-subset / nested / not-a-group parent …) surfaces as DomainError
   *  E_INVALID_ARG + hint for the model to read. */
  createGroupSession(
    input: {
      title: string
      groupMembers: string[]
      parentSessionId?: number | null
      invokedBy?: string
    },
    signal?: AbortSignal
  ): Promise<DomainGroupSessionCreated> {
    const body: Record<string, unknown> = {
      title: input.title,
      groupMembers: input.groupMembers
    }
    if (typeof input.parentSessionId === 'number') body.parentSessionId = input.parentSessionId
    if (typeof input.invokedBy === 'string') body.invokedBy = input.invokedBy
    return this._req<DomainGroupSessionCreated>('POST', '/chat/sessions/new', { body, signal })
  }

  /** group_create step 2 — PUT /chat/sessions/{id}/group-config (judge / modes / caps…; only
   *  the keys passed are written, explicit null clears a key). Server-validated. */
  setGroupConfig(
    sessionId: number,
    patch: Partial<GroupConfig> & { modes?: Record<string, 'realtime' | 'mention'> },
    signal?: AbortSignal
  ): Promise<void> {
    return this._req<void>('PUT', `/chat/sessions/${sessionId}/group-config`, {
      body: patch,
      signal
    })
  }

  /** group_create compensation — DELETE /chat/sessions/{id} (messages + tool calls cascade).
   *  Idempotent server-side (an unknown id still answers deleted:true). */
  deleteSession(sessionId: number, signal?: AbortSignal): Promise<void> {
    return this._req<void>('DELETE', `/chat/sessions/${sessionId}`, { signal })
  }

  // ── self-mount primitives (M4) — the agent reads/proposes its own Standing Context docs +
  //    skills. All hit /agent/* (verify_cf_access dual-auth: the embedded gateway's local-token leg
  //    passes — owner-equivalent on loopback). The gateway ApprovalGuard gates the writes; rules
  //    content is validated server-side. The tools that call these are only registered when
  //    MAILAGENT_SKILL_SELF_MOUNT is on.

  /** update_system_md (M4b) — overwrite a Standing Context doc. POST /agent/profile/docs/{name}.
   *  For name==='rules' the server runs validate_rules_content → 400 E_INVALID_ARG (→ DomainError)
   *  on a jailbreak/override phrase. The tool passes updatedBy='agent_proposed'. */
  setProfileDoc(
    name: string,
    body: { content: string; updatedBy?: string; sessionId?: number; messageId?: number },
    signal?: AbortSignal
  ): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'POST',
      `/agent/profile/docs/${encodeURIComponent(name)}`,
      { body, signal }
    )
  }

  // ── profile-config primitives (S1 R2) — read/history/restore Standing Context docs +
  //    memory.md edit. Same /agent/* owner surface as setProfileDoc (verify_cf_access local-token
  //    leg). The tools that call these are only registered when MAILAGENT_OPENNESS_CONFIG_TOOLS
  //    is on; the two writes are gated by the gateway ApprovalGuard (edit-tier, always ask).

  /** agent_profile_read (S1 R2) — full content + version info of one profile doc
   *  (soul/agent/rules/user/memory). GET /agent/profile/docs/{name}; memory carries
   *  budgetChars. */
  readProfileDoc(name: string, signal?: AbortSignal): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'GET',
      `/agent/profile/docs/${encodeURIComponent(name)}`,
      { signal }
    )
  }

  /** agent_profile_history (S1 R2) — version history (newest first). GET /agent/profile/history
   *  ?docName=&limit= → data.history. */
  async listProfileHistory(
    docName: string,
    limit?: number,
    signal?: AbortSignal
  ): Promise<DomainProfileHistoryEntry[]> {
    const data = await this._req<{ history: DomainProfileHistoryEntry[] }>(
      'GET',
      '/agent/profile/history',
      { query: { docName, limit }, signal }
    )
    return data.history ?? []
  }

  /** agent_profile_restore (S1 R2) — roll a profile doc back to a history version. POST
   *  /agent/profile/docs/{name}/rollback {targetHash}. For name==='rules' the server re-runs
   *  validate_rules_content on the target snapshot → 400 E_INVALID_ARG (→ DomainError) so a
   *  jailbreak version can never be revived. The tool passes updatedBy='agent_proposed'. */
  rollbackProfileDoc(
    name: string,
    targetHash: string,
    signal?: AbortSignal
  ): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'POST',
      `/agent/profile/docs/${encodeURIComponent(name)}/rollback`,
      { body: { targetHash, updatedBy: 'agent_proposed' }, signal }
    )
  }

  /** agent_memory_update (S1 R2) — overwrite memory.md (bounded memory). POST
   *  /agent/profile/docs/memory; the server enforces the hard character budget → 400
   *  E_INVALID_ARG (→ DomainError) when exceeded. Kept separate from setProfileDoc so the
   *  identity boundary stays explicit (memory ≠ Standing Context identity doc). */
  setMemoryDoc(content: string, signal?: AbortSignal): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>('POST', '/agent/profile/docs/memory', {
      body: { content, updatedBy: 'agent_proposed' },
      signal
    })
  }

  /** discover_skills (M4c) — list resolved skills (enabled/available/unavailableReason/toolCount).
   *  GET /agent/skills → data.skills. */
  async listResolvedSkills(signal?: AbortSignal): Promise<DomainResolvedSkill[]> {
    const data = await this._req<{ skills: DomainResolvedSkill[] }>('GET', '/agent/skills', {
      signal
    })
    return data.skills ?? []
  }

  /** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). POST
   *  /agent/skills/{name}/enabled {enabled}. */
  setSkillEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<{ name: string; enabled: boolean }> {
    return this._req<{ name: string; enabled: boolean }>(
      'POST',
      `/agent/skills/${encodeURIComponent(name)}/enabled`,
      { body: { enabled }, signal }
    )
  }

  // ── web primitives (S1 R3) — outbound network via serve-api /web/* (never node:fetch in the
  //    gateway core): the business authority (SSRF guard, IP pinning, content extraction) lives in
  //    Python (routers/web.py) → remote parity for free. The tools that call these are only
  //    registered when MAILAGENT_OPENNESS_WEB_TOOLS is on; both are edit-tier (always ask).

  /** web_fetch (S1 R3) — fetch one http/https URL's content (SSRF-guarded, IP-pinned server-side).
   *  POST /web/fetch {url, max_chars}. Returns the extracted text (untrusted) + metadata.
   *  `constrain` (S6 W3, ADR-004 rev3.1 D-fix-1) — a gated headless agent fetch passes the run's
   *  agentId + derived contextMode so the endpoint enforces the per-agent redirect origin
   *  whitelist (the SAME enabled+dual-key candidate set policyEvaluate consults, resolved
   *  server-side — the gateway never assembles the origin list). Absent (manual / open tier) →
   *  the body is byte-identical to the S1 shape. */
  webFetch(
    url: string,
    maxChars: number,
    signal?: AbortSignal,
    constrain?: { agentId: string; contextMode: string }
  ): Promise<DomainWebFetchResult> {
    const body: Record<string, unknown> = { url, max_chars: maxChars }
    if (constrain) {
      body.agent_id = constrain.agentId
      body.context_mode = constrain.contextMode
    }
    return this._req<DomainWebFetchResult>('POST', '/web/fetch', { body, signal })
  }

  /** web_search (S1 R3) — DuckDuckGo web search (best-effort). POST /web/search {query, limit}. */
  webSearch(query: string, limit: number, signal?: AbortSignal): Promise<DomainWebSearchResult> {
    return this._req<DomainWebSearchResult>('POST', '/web/search', {
      body: { query, limit },
      signal
    })
  }

  // ── notion-agent primitive (task 07-21) — delegate a Notion request to the notion-agent CLI via
  //    the unified Skill Delivery invoke面 (POST /api/skills/invoke). The gateway never spawns the
  //    subprocess itself — Python's builtin notion_agent skill handler owns the subprocess bridge
  //    (serial gate + idle watchdog, src/skills/builtin/notion_agent.py → src/chat/notion_agent.py).
  //    The loopback local-token authenticates as the OWNER principal (scopes=None) so the tool's
  //    notion_agent:invoke scope passes. The server-side ToolDef confirmation_tier is 'edit' (codex
  //    HIGH-2 raised it from 'preview'), so a raw /api/skills/invoke call needs confirm=true; the
  //    gateway passes confirm=true only AFTER its own 恒-HITL card is approved (the tool is edit-tier
  //    HITL at the gateway too — the human decision reaches both gates). The tool
  //    that calls this is only registered when MAILAGENT_NOTION_AGENT_TOOL is on AND the notion_agent
  //    skill is advertised (SkillsSection toggle → skill_gating). ──

  /** notion_agent_chat (task 07-21) — run one notion-agent request. POST /api/skills/invoke
   *  {skill:'notion_agent', tool:'notion_agent_chat', input:{prompt, thread_id?, model?}}. Returns
   *  the tool result {final_content, thread_id}. */
  notionAgentChat(
    prompt: string,
    opts: { threadId?: string; model?: string },
    signal?: AbortSignal
  ): Promise<DomainNotionAgentChatResult> {
    const input: Record<string, unknown> = { prompt }
    if (opts.threadId !== undefined) input.thread_id = opts.threadId
    if (opts.model !== undefined) input.model = opts.model
    // 07-21 (codex HIGH-2) — notion_agent_chat is confirmation_tier=edit server-side, so the invoke
    // chokepoint requires an explicit boolean confirm=true (mirrors send/draft). This method only
    // runs from the gateway tool's execute, i.e. AFTER the 恒-HITL card was approved — so passing
    // confirm:true here is the human decision reaching Python's second gate (defense in depth). A
    // direct external /api/skills/invoke without confirm still 403s.
    return this._req<DomainNotionAgentChatResult>('POST', '/skills/invoke', {
      body: { skill: 'notion_agent', tool: 'notion_agent_chat', input, confirm: true },
      signal
    })
  }

  // ── MCP connector primitives (stage 1 PR2, MAILAGENT_MCP_CONNECTORS) — the connector tool
  //    manifest + call proxy live in Python serve-api /connector/* (the MCP client, OAuth
  //    credentials and the tool whitelist are all Python-side; the gateway only carries the
  //    envelope — web.ts / notion_agent.ts discipline). All three are only ever called when the
  //    flag is on AND the run is manual chat (tools/connector.ts + the lifecycle seam). ──

  /** List connectors (registry ∪ DB runtime state). GET /connector. */
  listConnectors(signal?: AbortSignal): Promise<DomainConnectorList> {
    return this._req<DomainConnectorList>('GET', '/connector', { signal })
  }

  /** List one connector's synced tool manifest (effective_mode already folded server-side —
   *  08-05 per-tool tiers; orphan rows still listed — the registration seam skips them).
   *  GET /connector/{id}/tools. */
  listConnectorTools(connectorId: string, signal?: AbortSignal): Promise<DomainConnectorTools> {
    return this._req<DomainConnectorTools>(
      'GET',
      `/connector/${encodeURIComponent(connectorId)}/tools`,
      { signal }
    )
  }

  /** Invoke one connector tool through the serve-api MCP call proxy (whitelist-gated server-side:
   *  unsynced/orphan/delete/disabled names never reach the remote; the result is already truncated
   *  to CALL_RESULT_MAX_CHARS). POST /connector/{id}/tools/{name}/invoke.
   *  `caller` (PR3) — the invocation provenance the gateway ALWAYS sends (manual →
   *  {context_mode:'manual_chat'}; headless → the actual mode + agent_id). 🔴 This is NOT a mere
   *  audit annotation: Python's `resolve_caller_ceiling` gates on it (manual → no ceiling, byte
   *  identical to PR2; headless → re-reads that agent's grant_connectors and denies 403 without a
   *  grant or above the ceiling; any other venue → hard deny; bad shape → 400). Sending a wrong /
   *  missing mode therefore CHANGES authorization — the gateway matrix + registration filter are
   *  the FIRST belt, this wire field is what lets the second one exist server-side. */
  invokeConnectorTool(
    connectorId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    caller?: { contextMode: string; agentId?: string }
  ): Promise<DomainConnectorInvokeResult> {
    const body: Record<string, unknown> = { arguments: args ?? {} }
    if (caller) {
      body.caller = {
        context_mode: caller.contextMode,
        ...(caller.agentId !== undefined ? { agent_id: caller.agentId } : {})
      }
    }
    return this._req<DomainConnectorInvokeResult>(
      'POST',
      `/connector/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}/invoke`,
      { body, signal }
    )
  }

  // ── exec primitives (S2 W1) — local command / filesystem execution via serve-api /exec/* (never
  //    child_process/fs in the gateway core): the business authority (fixed env allowlist, inode
  //    deny floor, no shell) lives in Python (routers/exec.py) → remote parity for free. The tools
  //    that call these are only registered when MAILAGENT_OPENNESS_EXEC_TOOLS is on; all three are
  //    edit-tier (always ask unless a whitelist rule matches).

  /** run_command (S2 W1) — run one local command (NO shell). POST /exec/run {argv, cwd?, timeout_ms}.
   *  `audit` (S5 W4, ADR-004 D4 附带项) — PURE audit annotation (context_mode + agent_id) for a
   *  headless agent run's ledger row; the endpoint never gates on it (authorization stays in the
   *  gateway matrix + evaluate). Absent (manual) → body byte-identical to the S2 shape. */
  runCommand(
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number },
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecRunResult> {
    const body: Record<string, unknown> = { argv }
    if (opts.cwd !== undefined) body.cwd = opts.cwd
    if (opts.timeoutMs !== undefined) body.timeout_ms = opts.timeoutMs
    this._applyExecAudit(body, audit)
    return this._req<DomainExecRunResult>('POST', '/exec/run', { body, signal })
  }

  /** file_read (S2 W1) — read a local file's text. POST /exec/file_read {path, max_bytes}.
   *  Sensitive targets → DomainError E_EXEC_FLOOR_DENIED (the inode deny floor). */
  fileRead(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecFileReadResult> {
    const body: Record<string, unknown> = { path, max_bytes: maxBytes }
    this._applyExecAudit(body, audit)
    return this._req<DomainExecFileReadResult>('POST', '/exec/file_read', { body, signal })
  }

  /** file_write (S2 W1) — write text to a local file. POST /exec/file_write {path, content, mode}.
   *  Sensitive targets → DomainError E_EXEC_FLOOR_DENIED; create_new on an existing file → E_FILE_EXISTS. */
  fileWrite(
    path: string,
    content: string,
    mode: 'overwrite' | 'append' | 'create_new',
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecFileWriteResult> {
    const body: Record<string, unknown> = { path, content, mode }
    this._applyExecAudit(body, audit)
    return this._req<DomainExecFileWriteResult>('POST', '/exec/file_write', { body, signal })
  }

  /** S5 W4 — stamp the /exec/* audit annotation fields (snake_case per the Python body schema)
   *  onto a request body. Absent/empty audit → the body is untouched (manual byte-identical). */
  private _applyExecAudit(
    body: Record<string, unknown>,
    audit?: { contextMode?: string; agentId?: string }
  ): void {
    if (audit?.contextMode != null) body.context_mode = audit.contextMode
    if (audit?.agentId != null) body.agent_id = audit.agentId
  }

  // ── approval mode (07-16 approval-mode switcher) ─────────────────────────────────────────────

  /** GET /agent/approval-mode → the owner-global chat approval mode row
   *  ({mode: 'manual'|'bypass'} — 08-05 WP-11 retired 'acceptEdits'; serve-api fail-closes dirty
   *  and legacy rows to 'manual'). Consulted by the lifecycle's resolveGlobalApprovalMode
   *  (short-TTL cache + bounded timeout, any failure → 'manual'). READ-ONLY from the gateway:
   *  mode switching is an owner UI action (verify_cf_access endpoint) — no gateway tool can
   *  reach the PUT. */
  getApprovalMode(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/approval-mode', { signal })
  }

  /** g1 群聊 labs — GET /agent/labs → owner_settings 的实验开关行（今天只有
   *  `{groupAgents: 'on'|'off'}`，key `labs_group_agents`；缺行 / 脏值 serve-api 一律返 'off'）。
   *  由 lifecycle 的 resolveLabsFlags 消费（短 TTL + 有界超时，任何失败 → off，fail-closed）。
   *  READ-ONLY from the gateway：开关是 owner UI 动作（verify_cf_access PUT），没有任何 gateway
   *  工具够得着写面（policy_rules 同款纪律）。 */
  getLabsFlags(signal?: AbortSignal): Promise<{ groupAgents: string }> {
    return this._req<{ groupAgents: string }>('GET', '/agent/labs', { signal })
  }

  /** T4 主 agent 入群 — GET /agent/assistant-identity → owner_settings 的主 agent 显示身份
   *  ({name, avatar}；缺行 / 坏 JSON serve-api 自己 fail-open 成 {null, null}）。
   *
   *  🔴 任何读失败（E_NOT_FOUND / 网络 / serve-api 抖动）→ null，**不 throw**：唯一调用方是
   *  resolveGroupSession 的保留字分支，那里的硬约束是「成员绝不能因为读配置失败而消失」
   *  （成员事实是 speakAsAgentId 的安全判据，丢了就是 403）。返回 null 时调用方 push 一个
   *  降级成员，而不是丢掉这个成员。abort 照 _req 的约定原样抛（调用方要能区分取消）。
   *  READ-ONLY：身份的写面是 owner UI 的 PUT，没有 gateway 工具够得着。 */
  async getAssistantIdentity(signal?: AbortSignal): Promise<AssistantIdentity | null> {
    try {
      return await this._req<AssistantIdentity>('GET', '/agent/assistant-identity', { signal })
    } catch (e) {
      if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) throw e
      return null
    }
  }

  /** g1 群聊 — POST /agent-runs/run-log：把一个群 spoke turn 镜像成一行 `agent_run_log`
   *  （团队页执行记录可见）。🔴 best-effort 语义在**调用方**（lifecycle 的 mirrorGroupRunLog
   *  catch 掉一切只 warn）：群消息在 ai_chat.db、run log 在 sync_store.db，跨库无事务，
   *  `ai_chat_group_turn` 才是指标权威源。
   *  🔴 `status` 值域 = run_log.py 的 AGENT_RUN_LOG_STATUS_VALUES（running / completed /
   *  failed / skipped，**没有 'stopped'**）；`steps[].kind` ∈ AGENT_RUN_STEP_KINDS，本路径只用
   *  trig / out。越域由服务端 400，不在这里静默改写。 */
  postRunLog(
    input: {
      agentId: string
      startedAtMs: number
      completedAtMs?: number | null
      status: string
      triggerKind?: string | null
      triggerDetail?: string | null
      summary?: string | null
      model?: string | null
      inputTokens?: number | null
      outputTokens?: number | null
      error?: string | null
      steps?: Array<{
        kind: string
        name?: string | null
        detail?: string | null
        payload?: Record<string, unknown> | null
        ok?: boolean | null
        ms?: number | null
      }>
    },
    signal?: AbortSignal
  ): Promise<{ runLogId: number | null }> {
    return this._req<{ runLogId: number | null }>('POST', '/agent-runs/run-log', {
      body: input,
      signal
    })
  }

  /** P4 GET /agent/auto-compact. Read-only from the gateway; only owner UI reaches PUT. */
  getAutoCompactSetting(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/auto-compact', { signal })
  }

  /** 0812 dogfood GET /agent/matter-web-face → the owner's web tier for Matter follow-up runs
   *  ({mode: 'keep'|'search_only'|'off'}; serve-api reads dirty/missing rows as 'keep'). Consulted
   *  by the lifecycle's resolveMatterRunWebFace (short-TTL cache + bounded timeout; any failure →
   *  'keep', fail-SAFE). Read-only from the gateway: the tier is an owner UI action
   *  (verify_cf_access PUT) — no gateway tool can reach it (policy_rules 同款纪律). */
  getMatterRunWebFace(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/matter-web-face', { signal })
  }

  /** 08-05 WP-11 — GET /agent/tool-prefs → the per-tool approval tiers of every built-in write
   *  tool (factory default + explicit override + folded effective) + the send recipient
   *  whitelist. Consulted by the lifecycle's resolveToolApprovalPrefs (short-TTL cache; any
   *  failure → null = ask semantics). READ-ONLY from the gateway: tier writes are owner UI
   *  actions (verify_cf_access endpoints) — no gateway tool can reach them (policy_rules 纪律). */
  getToolApprovalPrefs(signal?: AbortSignal): Promise<{
    tools: Array<{
      toolName: string
      group: string
      defaultTier: string
      tier: string | null
      effectiveTier: string
      configurable: boolean
      dangerAuto: boolean
    }>
    sendWhitelist: string[]
    acceptEditsPreset: string[]
  }> {
    return this._req('GET', '/agent/tool-prefs', { signal })
  }

  /** L4 批次1 #6 — POST /approval/preview → the approval-card line built from the REAL payload
   *  (server-derived reply-all recipients, the calendar row's CURRENT title/times …). `preview`
   *  is null when no deriver covers that tool — the normal case, and the caller (chatRun's
   *  resolveApprovalPreview) then falls back to the model's own args. NOT a write: it reads
   *  domain facts for a human to review, and the Python side never mutates. */
  async fetchApprovalPreview(
    toolName: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<string | null> {
    const data = await this._req<{ toolName: string; preview: string | null }>(
      'POST',
      '/approval/preview',
      { body: { toolName, input }, signal }
    )
    return typeof data?.preview === 'string' && data.preview.length > 0 ? data.preview : null
  }

  // ── policy primitives (S2 W1) — the structured whitelist. evaluate is consulted by the exec
  //    tools' needsApproval (auto_allow → skip card); the CRUD methods back the Settings automation
  //    policy page + the approval-card "always allow" affordance (rule creation is an OWNER action
  //    only — no gateway TOOL creates rules). All hit /agent/policy/* (owner API, verify_cf_access).

  /** POST /agent/policy/evaluate {capability, action, contextMode, agentId?} → the whitelist
   *  verdict. Called from the exec/write tools' needsApproval with the run's SERVER-ASSERTED
   *  contextMode (never a body value). `agentId` (S5 W4, ADR-004) keys the per-agent candidate
   *  set for a headless agent run — absent (every manual run) → the request body is byte-identical
   *  to the pre-ADR-004 shape and Python evaluates the manual (agent_id IS NULL) candidates. */
  policyEvaluate(
    capability: string,
    action: Record<string, unknown>,
    contextMode: string,
    signal?: AbortSignal,
    agentId?: string
  ): Promise<DomainPolicyVerdict> {
    return this._req<DomainPolicyVerdict>('POST', '/agent/policy/evaluate', {
      body: { capability, action, contextMode, ...(agentId != null ? { agentId } : {}) },
      signal
    })
  }

  /** GET /agent/policy/rules?capability=&contextMode= → data.rules (newest first). */
  async listPolicyRules(
    opts: { capability?: string; contextMode?: string } = {},
    signal?: AbortSignal
  ): Promise<DomainPolicyRule[]> {
    const data = await this._req<{ rules: DomainPolicyRule[] }>('GET', '/agent/policy/rules', {
      query: { capability: opts.capability, contextMode: opts.contextMode },
      signal
    })
    return data.rules ?? []
  }

  /** POST /agent/policy/rules {capability, matcher, contextMode?, note?} → the created rule (201).
   *  A malformed matcher → DomainError E_INVALID_ARG (422). This is the ONLY rule-creation path
   *  (approval-card "always allow" + Settings); no gateway tool can reach it. */
  createPolicyRule(
    input: {
      capability: string
      matcher: Record<string, unknown>
      contextMode?: string
      note?: string
      /** S6 W3-3 (ADR-004) — per-agent headless rule (web "always allow this domain" PIN). When
       *  present the endpoint DERIVES contextMode from the agent trigger and REJECTS an explicit
       *  contextMode, so the caller passes agentId XOR contextMode (never both). */
      agentId?: string
    },
    signal?: AbortSignal
  ): Promise<DomainPolicyRule> {
    const body: Record<string, unknown> = { capability: input.capability, matcher: input.matcher }
    if (input.contextMode !== undefined) body.contextMode = input.contextMode
    if (input.note !== undefined) body.note = input.note
    if (input.agentId !== undefined) body.agentId = input.agentId
    return this._req<DomainPolicyRule>('POST', '/agent/policy/rules', { body, signal })
  }

  /** PATCH /agent/policy/rules/{id} {enabled?, note?} → the updated rule. matcher is NOT patchable
   *  (widening = delete + recreate). Missing id → DomainError E_NOT_FOUND (404). */
  setPolicyRule(
    id: number,
    patch: { enabled?: boolean; note?: string },
    signal?: AbortSignal
  ): Promise<DomainPolicyRule> {
    const body: Record<string, unknown> = {}
    if (patch.enabled !== undefined) body.enabled = patch.enabled
    if (patch.note !== undefined) body.note = patch.note
    return this._req<DomainPolicyRule>('PATCH', `/agent/policy/rules/${id}`, { body, signal })
  }

  /** DELETE /agent/policy/rules/{id} → {id, removed} (idempotent). */
  deletePolicyRule(id: number, signal?: AbortSignal): Promise<{ id: number; removed: boolean }> {
    return this._req<{ id: number; removed: boolean }>('DELETE', `/agent/policy/rules/${id}`, {
      signal
    })
  }

  // ── skill-supply primitives (S2 W4) — two-step install (fetch→quarantine→confirm re-hash),
  //    full-cleanup uninstall, and the SKILL.md read. All hit /agent/skills/* (owner API,
  //    verify_cf_access — the embedded gateway's local-token leg passes). The tools that call
  //    these are only registered when MAILAGENT_OPENNESS_SKILL_INSTALL is on; the three writes
  //    are gated by the gateway ApprovalGuard (edit-tier + class capability_change: always ask).

  /** skill_install (S2 W4) — stage one: download/import a skill package into quarantine.
   *  POST /agent/skills/fetch {sourceUrl?|localPath?} (exactly one). Returns the preview facts
   *  (quarantine id + real hashes + manifest summary + declared secret names + SKILL.md excerpt). */
  skillSupplyFetch(
    input: { sourceUrl?: string; localPath?: string },
    signal?: AbortSignal
  ): Promise<DomainSkillFetchPreview> {
    const body: Record<string, unknown> = {}
    if (input.sourceUrl !== undefined) body.sourceUrl = input.sourceUrl
    if (input.localPath !== undefined) body.localPath = input.localPath
    return this._req<DomainSkillFetchPreview>('POST', '/agent/skills/fetch', { body, signal })
  }

  /** skill_install_confirm (S2 W4) — stage two: really install a quarantined package. POST
   *  /agent/skills/confirm {quarantineId, expectedPackageHash, expectedFiles?}. The server
   *  RE-HASHES the quarantine content against the expected values → 409 E_PACK_HASH_MISMATCH
   *  (→ DomainError) on any drift (TOCTOU guard — a forged hash only defeats the install). */
  skillSupplyConfirm(
    input: {
      quarantineId: string
      expectedPackageHash: string
      expectedFiles?: Record<string, string>
    },
    signal?: AbortSignal
  ): Promise<DomainSkillConfirmResult> {
    const body: Record<string, unknown> = {
      quarantineId: input.quarantineId,
      expectedPackageHash: input.expectedPackageHash
    }
    if (input.expectedFiles !== undefined) body.expectedFiles = input.expectedFiles
    return this._req<DomainSkillConfirmResult>('POST', '/agent/skills/confirm', { body, signal })
  }

  /** skill_uninstall (S2 W4) — full cleanup (row + on-disk dir + stored secrets). POST
   *  /agent/skills/uninstall {name} — NEVER the legacy row-only DELETE (stale-secret adoption). */
  skillSupplyUninstall(name: string, signal?: AbortSignal): Promise<DomainSkillUninstallResult> {
    return this._req<DomainSkillUninstallResult>('POST', '/agent/skills/uninstall', {
      body: { name },
      signal
    })
  }

  /** skill_read (S2 W4) — an installed skill's raw SKILL.md. GET /agent/skills/{name}/doc.
   *  The TOOL fences (UNTRUSTED_SKILL_DOC) + truncates before the model sees the content. */
  skillDocRead(name: string, signal?: AbortSignal): Promise<DomainSkillDocResult> {
    return this._req<DomainSkillDocResult>('GET', `/agent/skills/${encodeURIComponent(name)}/doc`, {
      signal
    })
  }

  skillDraftCreate(
    input: { name: string; manifest?: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<DomainSkillDraft> {
    return this._req<DomainSkillDraft>('POST', '/agent/skills/drafts', { body: input, signal })
  }

  skillDraftWriteFile(
    input: { draftId: string; path: string; content: string },
    signal?: AbortSignal
  ): Promise<{ path: string; bytes: number }> {
    return this._req('PUT', `/agent/skills/drafts/${encodeURIComponent(input.draftId)}/file`, {
      body: { path: input.path, content: input.content },
      signal
    })
  }

  skillDraftGet(draftId: string, signal?: AbortSignal): Promise<DomainSkillDraft> {
    return this._req('GET', `/agent/skills/drafts/${encodeURIComponent(draftId)}`, { signal })
  }

  skillDraftReadFile(
    draftId: string,
    path: string,
    signal?: AbortSignal
  ): Promise<{ path: string; content: string }> {
    return this._req('GET', `/agent/skills/drafts/${encodeURIComponent(draftId)}/file`, {
      query: { path },
      signal
    })
  }

  skillDraftValidate(
    draftId: string,
    signal?: AbortSignal
  ): Promise<{ draftId: string; validation: Record<string, unknown> }> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/validate`, {
      body: {},
      signal
    })
  }

  skillDraftPublish(
    draftId: string,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/publish`, {
      body: { enabled },
      signal
    })
  }

  skillDraftDiscard(draftId: string, signal?: AbortSignal): Promise<DomainSkillDraft> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/discard`, {
      body: {},
      signal
    })
  }

  // ── agent-run primitives (S4 W3) — the headless custom-agent run's spec pull + approval回写. Both
  //    hit /agent-runs/* (owner surface, verify_local_token — the embedded gateway's local-token leg).
  //    Called ONLY by the lifecycle's fetchAgentRunSpec hook (gate) + onServerResumeSettled, and only
  //    when MAILAGENT_CUSTOM_AGENTS_ENABLED is on.

  /** fetchAgentRunSpec (S4 W3) — pull the authoritative agent-run spec by jobId + claimToken (D2
   *  one-shot CAS server-side). GET /agent-runs/{jobId}/spec with the X-Claim-Token header. E_SPEC_*
   *  envelope errors (403 forbidden / 404 not-found / 409 already-claimed / 409 agent-invalid)
   *  surface as DomainError (code + httpStatus) → the endpoint forwards them to the worker. */
  fetchAgentRunSpec(
    jobId: number,
    claimToken: string,
    signal?: AbortSignal
  ): Promise<AgentRunSpec> {
    return this._req<AgentRunSpec>('GET', `/agent-runs/${jobId}/spec`, {
      headers: { 'X-Claim-Token': claimToken },
      signal
    })
  }

  /** settleAgentApprovalState (S4 W3) — write a headless run's terminal approval decision after an
   *  island resume (D4, by-job-id). POST /agent-runs/{jobId}/approval-state {state}. Only migrates
   *  from pending; a non-pending job → DomainError E_APPROVAL_NOT_PENDING (409, best-effort — the
   *  caller ignores it). */
  settleAgentApprovalState(
    jobId: number,
    state: 'approved' | 'rejected',
    signal?: AbortSignal
  ): Promise<{ jobId: number; approvalState: string; idempotent: boolean }> {
    return this._req<{ jobId: number; approvalState: string; idempotent: boolean }>(
      'POST',
      `/agent-runs/${jobId}/approval-state`,
      { body: { state }, signal }
    )
  }

  enqueueAgentCall(
    body: {
      agent_id: string
      fire_key: string
      session_id: number
      invocation: Record<string, unknown>
    },
    signal?: AbortSignal
  ): Promise<DomainAgentCallEnqueueResult> {
    return this._req<DomainAgentCallEnqueueResult>('POST', '/agent-runs/call', { body, signal })
  }

  getAgentRun(jobId: number, signal?: AbortSignal): Promise<DomainAgentRunDetail> {
    return this._req<DomainAgentRunDetail>('GET', `/agent-runs/${jobId}`, { signal })
  }

  cancelAgentRun(
    jobId: number,
    signal?: AbortSignal
  ): Promise<{ cancelled: boolean; state?: string }> {
    return this._req<{ cancelled: boolean; state?: string }>(
      'POST',
      `/agent-runs/${jobId}/cancel`,
      { signal }
    )
  }

  // ── custom-agent CRUD primitives (S5 W3) — the conversational build/edit/run surface. All hit the
  //    SAME report-agent REST endpoints W1 opened for type='custom' (owner API, verify_cf_access —
  //    the embedded gateway's local-token leg passes). Deep validation (trigger/tool_policy/budget)
  //    is Python-authoritative (validate_agent_config_patch) — the client never re-validates. The
  //    tools that call these are only registered when MAILAGENT_CUSTOM_AGENTS_ENABLED is on.

  /** custom_agent_list — all agent configs (the tool filters to type='custom'). GET /report-agents. */
  listReportAgents(signal?: AbortSignal): Promise<ReportAgentConfig[]> {
    return this._req<ReportAgentConfig[]>('GET', '/report-agents', { signal })
  }

  /** Resolve the backend-owned default allowed-tools set when a legacy/null tool policy is edited
   *  through capability tiers. This prevents a partial tier patch from erasing untouched defaults. */
  getAgentRunToolOptions(signal?: AbortSignal): Promise<AgentRunToolOptions> {
    return this._req<AgentRunToolOptions>('GET', '/agent-runs/tool-options', { signal })
  }

  /** custom_agent_get — one agent config by id. GET /report-agents?agentId=. E_NOT_FOUND → null. */
  async getReportAgent(agentId: string, signal?: AbortSignal): Promise<ReportAgentConfig | null> {
    try {
      return await this._req<ReportAgentConfig>('GET', '/report-agents', {
        query: { agentId },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** custom_agent_create — new agent row (type pinned to 'custom' by the tool). POST /report-agents.
   *  A duplicate id → DomainError E_CONFLICT (409); a bad trigger → E_INVALID_ARG (deep-validated
   *  server-side). The wire body carries only the friendly patch fields the tool assembled. */
  createReportAgent(
    input: ReportAgentCreateInput & ReportConfigPatch,
    signal?: AbortSignal
  ): Promise<ReportAgentConfig> {
    return this._req<ReportAgentConfig>('POST', '/report-agents', { body: input, signal })
  }

  /** custom_agent_update — partial patch of an existing agent. PUT /report-agents/{id}. Missing id →
   *  DomainError E_NOT_FOUND (404); a bad trigger → E_INVALID_ARG (server validate_agent_config_patch). */
  setReportAgentConfig(
    agentId: string,
    patch: ReportConfigPatch,
    signal?: AbortSignal
  ): Promise<ReportAgentConfig> {
    return this._req<ReportAgentConfig>('PUT', `/report-agents/${encodeURIComponent(agentId)}`, {
      body: patch,
      signal
    })
  }

  /** custom_agent_delete — delete an agent row. DELETE /report-agents/{id}. Missing → E_NOT_FOUND. */
  deleteReportAgent(agentId: string, signal?: AbortSignal): Promise<{ deleted: string }> {
    return this._req<{ deleted: string }>(
      'DELETE',
      `/report-agents/${encodeURIComponent(agentId)}`,
      { signal }
    )
  }

  /** custom_agent_run_now — enqueue one immediate run (custom → run_queue, S4 enqueue). POST
   *  /report-agents/{id}/run → {jobId, agentId, wasCreated}. A runs/day budget miss → DomainError
   *  E_BUDGET; a non-custom/report agent → E_INVALID_ARG. */
  runReportAgentNow(
    agentId: string,
    signal?: AbortSignal
  ): Promise<{ jobId: number; agentId: string; wasCreated: boolean }> {
    return this._req<{ jobId: number; agentId: string; wasCreated: boolean }>(
      'POST',
      `/report-agents/${encodeURIComponent(agentId)}/run`,
      { body: {}, signal }
    )
  }

  /** custom_agent_get run history — the agent's recent runs (read態唯一经 derive_agent_run_state
   *  server-side). GET /agent-runs?agentId=&limit=. The 8-value `state` is authoritative; the tool
   *  never re-derives it. */
  listAgentRuns(agentId: string, limit: number, signal?: AbortSignal): Promise<AgentRunListItem[]> {
    // 08-31 起这个聚合返两种台账行：async_jobs run（既有形状）与 agent_run_log
    // （`kind: 'run_log'`，时间是 ISO 字符串）。工具把整行交给模型，不解读字段。
    return this._req<AgentRunListItem[]>('GET', '/agent-runs', {
      query: { agentId, limit },
      signal
    })
  }

  // ── calendar primitives (calendar epic 4.1/4.2) — the local calendar SSoT reads + the CalDAV/
  //    iTIP writes via serve-api /calendar/* (routers/calendar.py is the business authority: CLI-
  //    mirrored branch semantics, strict tz-aware ISO validation, audit line per write) → remote
  //    parity for free. The tools that call these are only registered when
  //    MAILAGENT_CALENDAR_AGENT_TOOLS is on; the three writes are edit-tier (always ask, D4 恒 HITL).

  /** calendar_events_list — occurrences in a window (RRULE expanded server-side). GET
   *  /calendar/events (camelCase alias query; C7: data = the bare occurrence array). fromIso/toIso
   *  are FULL tz-aware ISO datetimes — the TOOL computes them from tz-local wall dates (P2-4), so
   *  the server's UTC-midnight default window is never consulted. */
  calendarEventsList(
    opts: { fromIso: string; toIso: string; calendarName?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>>> {
    return this._req<Array<Record<string, unknown>>>('GET', '/calendar/events', {
      query: {
        fromIso: opts.fromIso,
        toIso: opts.toIso,
        calendarName: opts.calendarName,
        limit: opts.limit
      },
      signal
    })
  }

  /** calendar_event_get — one event's full row by iCalendar UID. GET /calendar/events/{uid}
   *  (?source&recurrenceId; C7: data = the bare detail object). E_NOT_FOUND → null. */
  async calendarEventGet(
    eventId: string,
    opts: { source?: string; recurrenceId?: string } = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this._req<Record<string, unknown>>(
        'GET',
        `/calendar/events/${encodeURIComponent(eventId)}`,
        { query: { source: opts.source, recurrenceId: opts.recurrenceId }, signal }
      )
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** calendar_event_reschedule — CalDAV update. PATCH /calendar/events/{uid}; the body's
   *  recurrenceId/splitFuture combination selects the CLI-mirrored branch (整系列 / 改这一次
   *  detached / 改未来 split). startIso/endIso must be tz-aware (the server rejects naive). */
  calendarEventUpdate(
    eventId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>(
      'PATCH',
      `/calendar/events/${encodeURIComponent(eventId)}`,
      { body, signal }
    )
  }

  /** calendar_event_rsvp — send the IRREVOCABLE iTIP REPLY to the organizer (recipient is derived
   *  from the event row SERVER-SIDE — never a caller field). POST /calendar/events/{uid}/rsvp. */
  calendarEventRsvp(
    eventId: string,
    body: { response: string; recurrenceId?: string },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const wire: Record<string, unknown> = { response: body.response }
    if (body.recurrenceId !== undefined) wire.recurrenceId = body.recurrenceId
    return this._req<Record<string, unknown>>(
      'POST',
      `/calendar/events/${encodeURIComponent(eventId)}/rsvp`,
      { body: wire, signal }
    )
  }

  /** calendar_event_delete — CalDAV DELETE (irreversible; the HTTP request IS the confirmation —
   *  the gateway approval card is the human gate). DELETE /calendar/events/{uid}?calendarName=. */
  calendarEventDelete(
    eventId: string,
    calendarName?: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>(
      'DELETE',
      `/calendar/events/${encodeURIComponent(eventId)}`,
      { query: { calendarName }, signal }
    )
  }

  // ── 资料库（Library）read face — design §3. Rows come back snake_case (= DB columns); the
  //    projection into the tool's return shape lives in tools/library.ts, not here. `maxBytes` is
  //    the wire ceiling (READ_TOOL_MAX_BYTES); the 12000-char cap is applied tool-side. ──

  /** library_list — GET /library/folder. Omitting `path` asks for the library root. */
  libraryFolder(
    opts: { path?: string; limit: number; offset: number },
    signal?: AbortSignal
  ): Promise<DomainLibraryFolder> {
    return this._req<DomainLibraryFolder>('GET', '/library/folder', {
      query: { path: opts.path, limit: opts.limit, offset: opts.offset },
      signal
    })
  }

  /** library_read step 1 — GET /library/file/{id}: metadata + `content_hash` +, for text files,
   *  the body itself. */
  libraryFile(
    fileId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/file/${fileId}`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_read step 2 — GET /library/file/{id}/text: the parsed markdown (`library_text`), the
   *  same one the preview pane and FTS read. 🔴 This call is also what TRIGGERS extraction for a
   *  `pending` file (design §3 抽取兜底), so it is never a skippable round trip. */
  libraryFileText(
    fileId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/file/${fileId}/text`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_read on a PROJECTED mail attachment — GET /library/attachment/{attachment_id}
   *  and its /text sibling. Projections have no library id, so the `/file/{id}` family is
   *  structurally uncallable for them; these two are the library-native read face (the /text one
   *  reads `email_attachment_text` and does NOT re-extract). */
  libraryAttachment(
    attachmentId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/attachment/${attachmentId}`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  libraryAttachmentText(
    attachmentId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/attachment/${attachmentId}/text`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_search — GET /library/search. Keyword only (no DSL); `warning` carries the
   *  too-short-query notice so a 1-character query is not a silent zero-hit. */
  librarySearch(
    opts: { q: string; limit: number },
    signal?: AbortSignal
  ): Promise<DomainLibrarySearch> {
    return this._req<DomainLibrarySearch>('GET', '/library/search', {
      query: { q: opts.q, limit: opts.limit },
      signal
    })
  }

  // ── 资料库 write face (P2-L1) — routers/library.py 的写端点。Every write carries `actor` (see
  //    DomainLibraryActor). Authorization is SERVER-side (mail-attachments projection / .trash /
  //    ro mount refuse; custom agent → agent-docs/ only; main agent also my-docs/; WRITE_EXT_ALLOWLIST;
  //    size cap): the gateway sends identity + target, never a verdict, and a refusal comes back as a
  //    DomainError the tool surfaces verbatim. A CAS miss is 409 E_VERSION_CONFLICT with the envelope's
  //    top-level data = {content_hash, content} (DomainError.data, see _req). Request models are
  //    `extra="forbid"` — send exactly these keys. Rows come back as LibraryFile rows like the read face;
  //    projection lives in tools/library.ts. ──

  /** library_write mode=create_new — POST /library/files JSON (the renderer's createTextFile body
   *  + actor). `source` is fixed to 'agent': the gateway is the only agent-side producer. An
   *  occupied path → 409 E_VERSION_CONFLICT (no data). */
  libraryCreateFile(
    input: { parentPath: string; filename: string; content: string; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', '/library/files', {
      body: {
        parent_path: input.parentPath,
        filename: input.filename,
        content: input.content,
        source: 'agent',
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** library_write mode=overwrite — PUT /library/file/{id} {content, expected_hash, change_note,
   *  actor}. expected_hash ≠ current (or null) → 409 with data={content_hash, content}; same
   *  content → no-op (row returned unchanged, no history row). */
  libraryWriteFile(
    fileId: number,
    input: { content: string; expectedHash: string | null; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('PUT', `/library/file/${fileId}`, {
      body: {
        content: input.content,
        expected_hash: input.expectedHash,
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** library_append — POST /library/file/{id}/append {content, change_note, actor}. Additive (no
   *  CAS): the snapshot in history is still the full post-append text. */
  libraryAppendFile(
    fileId: number,
    input: { content: string; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', `/library/file/${fileId}/append`, {
      body: {
        content: input.content,
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** library_move — POST /library/file/{id}/move {target_path, actor}. `target_path` is a virtual
   *  path (a full new path, or an existing folder → filename kept). */
  libraryMoveFile(
    fileId: number,
    targetPath: string,
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', `/library/file/${fileId}/move`, {
      body: { target_path: targetPath, actor: libraryActorWire(actor) },
      signal
    })
  }

  /** library_delete — DELETE /library/file/{id}?actor_kind=&agent_id= : SOFT delete → .trash
   *  (restorable). The endpoint's `purge` query is a renderer-only affordance (mockup F11) the
   *  gateway never sends — omitted, so the server default (false) applies. */
  libraryTrashFile(
    fileId: number,
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('DELETE', `/library/file/${fileId}`, {
      query: { actor_kind: actor.kind, agent_id: actor.agentId },
      signal
    })
  }
}

/** `LibraryFolderPage` —— 🔴 没有 has_more，分页靠 total/limit/offset
 *  （单源 `frontend/src/shared/api/types/library.ts`）。 */
export interface DomainLibraryFolder {
  path?: unknown
  folders?: unknown
  files?: unknown
  total?: unknown
  limit?: unknown
  offset?: unknown
}

/** `LibrarySearchResponse` —— 🔴 键是 `hits` / `warnings`（不是 items / warning）。 */
export interface DomainLibrarySearch {
  query?: unknown
  mode?: unknown
  hits?: unknown
  warnings?: unknown
}
