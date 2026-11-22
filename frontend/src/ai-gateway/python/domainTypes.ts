// Shared Domain* DTO types for MailAgentDomainClient (extracted from domainClient.ts).
import type { AgentRunHistoryItem } from '@shared/api/types'

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
 *  'extracted' → text_content present (the page [offset, offset+max_chars) of the full text;
 *  `next_offset` non-null = more text follows, `truncated` flags any cut);
 *  'pending' | 'failed' | 'unsupported' → text_content null + a human-readable `hint`. */
export interface DomainAttachmentTextResult {
  attachment_id: number
  internal_id: number
  filename: string
  status: 'extracted' | 'pending' | 'failed' | 'unsupported'
  text_content: string | null
  offset: number
  total_chars: number | null
  next_offset: number | null
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
  images?: Array<{ media_type: string; data: string }>
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
    | 'auto_scope_grant'
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
  isUpgrade?: boolean
  previousVersion?: string | null
  previousPackageHash?: string | null
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
