// chat-panel P4 Phase 03a — zod input schemas for the AI SDK Gateway read tools.
//
// One zod schema per migrated read tool, mirroring the legacy JSON-Schema field
// names / constraints / defaults (shared/chat/tools/builtin/{email,attachment,kos,
// report}.ts) byte-for-byte so the model sees the same tool surface and the parity
// tests can drive both implementations from the SAME input fixtures. Exported so the
// parity tests import the canonical schemas rather than re-declaring them.
//
// 🔴 Tool-facing field names (snake_case, model-visible) — these are the LEGACY tool
//    param names, NOT the serve-api wire names. The domain client maps them to the
//    (inconsistent) wire params; see python/domainClient.ts.

import { z } from 'zod'

/** email_search — metadata filter (subject/sender/date/flags). All optional. */
export const emailSearchSchema = z.object({
  subject_contains: z.string().optional(),
  sender_contains: z.string().optional(),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type EmailSearchInput = z.infer<typeof emailSearchSchema>

/** email_search_fulltext — FTS body search (query required). */
export const emailSearchFulltextSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchFulltextInput = z.infer<typeof emailSearchFulltextSchema>

/** email_get — single email metadata. */
export const emailGetSchema = z.object({
  internal_id: z.number().int()
})
export type EmailGetInput = z.infer<typeof emailGetSchema>

/** email_body — markdown body (capped). */
export const emailBodySchema = z.object({
  internal_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000)
})
export type EmailBodyInput = z.infer<typeof emailBodySchema>

/** email_list_thread — all emails in a thread. */
export const emailListThreadSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailListThreadInput = z.infer<typeof emailListThreadSchema>

/** email_search_attachments — FTS over extracted attachment text (query required). */
export const emailSearchAttachmentsSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchAttachmentsInput = z.infer<typeof emailSearchAttachmentsSchema>

/** kos_query — cross-domain KOS retrieval. */
export const kosQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).default(10),
  expand: z.boolean().default(false),
  source_id: z.string().optional()
})
export type KosQueryInput = z.infer<typeof kosQuerySchema>

/** report_list — generated reports (all filters optional). */
export const reportListSchema = z.object({
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
  agent_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type ReportListInput = z.infer<typeof reportListSchema>

/** report_get — one report by id. */
export const reportGetSchema = z.object({
  report_id: z.string().min(1)
})
export type ReportGetInput = z.infer<typeof reportGetSchema>

// ── write-tool schemas (Phase 03b) — mirror the legacy JSON-Schema field names /
//    requireds from shared/chat/tools/builtin/write.ts byte-for-byte (parity). The
//    "at least one of …" semantic checks stay in the tool's run (matching the legacy
//    handler's E_INVALID_ARG), not the schema, so the error shape matches legacy. ──

/** email_flag — toggle is_read / is_flagged / processing_status (≥1 enforced in run). */
export const emailFlagSchema = z.object({
  internal_id: z.number().int(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  processing_status: z.string().optional()
})
export type EmailFlagInput = z.infer<typeof emailFlagSchema>

/** email_archive — move into Archive (davmail-only). */
export const emailArchiveSchema = z.object({
  internal_id: z.number().int()
})
export type EmailArchiveInput = z.infer<typeof emailArchiveSchema>

/** email_pin — pin / unpin (local UI flag). */
export const emailPinSchema = z.object({
  internal_id: z.number().int(),
  pinned: z.boolean()
})
export type EmailPinInput = z.infer<typeof emailPinSchema>

/** email_draft_reply — compose a reply-all draft. */
export const emailDraftReplySchema = z.object({
  internal_id: z.number().int(),
  body_markdown: z.string().min(1)
})
export type EmailDraftReplyInput = z.infer<typeof emailDraftReplySchema>

/** email_resync — re-push to Notion from the SQLite SSoT. */
export const emailResyncSchema = z.object({
  internal_id: z.number().int()
})
export type EmailResyncInput = z.infer<typeof emailResyncSchema>

// ── high-risk outbound send schema (Phase 04b) — the ONLY tool that triggers a real SMTP
//    send, and only after a blocking SendApprovalCard + the double guard (content hash +
//    idempotency, gateway + Python). Field names are the model-visible (snake_case) surface;
//    the domain client maps them to the serve-api /email/send-approved wire body. ────────────

/** email_prepare_send — propose a real outbound email for human approval. Recipients are
 *  explicit (a fresh "new" compose — it does NOT derive recipients from a source email).
 *  internal_id is optional context only (audit / which email this relates to); the send uses
 *  the explicit to/cc/bcc/subject/body. Attachments are NOT supported in v1 (the model cannot
 *  pass bytes; a future phase may reference existing attachments by id). */
export const emailPrepareSendSchema = z.object({
  to: z.array(z.string().min(3)).min(1),
  cc: z.array(z.string().min(3)).optional(),
  bcc: z.array(z.string().min(3)).optional(),
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
  internal_id: z.number().int().optional()
})
export type EmailPrepareSendInput = z.infer<typeof emailPrepareSendSchema>

// ── self-mount schemas (M4) — the agent updates its own Standing Context docs + skills. Behind
//    MAILAGENT_SKILL_SELF_MOUNT. update_system_md = edit-tier write (always asks); set_skill_enabled
//    = preview-tier write; discover_skills = silent read. Field names are the model-visible surface. ──

/** update_system_md (M4b) — propose new full content for one Standing Context doc. doc_name is the
 *  fixed backend enum (PROFILE_DOC_NAMES); rules content is additionally validated server-side
 *  (jailbreak / safety-override deny-list → E_INVALID_ARG). */
export const updateSystemMdSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user']),
  content: z.string().min(1)
})
export type UpdateSystemMdInput = z.infer<typeof updateSystemMdSchema>

/** discover_skills (M4c) — list capabilities (enabled + unavailable, with reasons). No input. */
export const discoverSkillsSchema = z.object({})
export type DiscoverSkillsInput = z.infer<typeof discoverSkillsSchema>

/** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). */
export const setSkillEnabledSchema = z.object({
  skill_name: z.string().min(1),
  enabled: z.boolean()
})
export type SetSkillEnabledInput = z.infer<typeof setSkillEnabledSchema>

// ── profile-config schemas (S1 R2) — the agent reads its own Standing Context docs / history
//    and proposes restores + memory.md updates. Behind MAILAGENT_OPENNESS_CONFIG_TOOLS.
//    doc_name is pinned to the backend STORABLE_DOC_NAMES enum (4 identity docs + memory —
//    wider than update_system_md's, which deliberately EXCLUDES memory: identity 边界).
//    Reads are silent; agent_profile_restore / agent_memory_update are edit-tier writes
//    (always ask, no editableFields → approve/reject only, update_system_md 先例). ──

/** agent_profile_read (S1 R2) — full content + version info of one profile doc. */
export const agentProfileReadSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory'])
})
export type AgentProfileReadInput = z.infer<typeof agentProfileReadSchema>

/** agent_profile_history (S1 R2) — version history of one profile doc (newest first). */
export const agentProfileHistorySchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory']),
  limit: z.number().int().min(1).max(100).default(20)
})
export type AgentProfileHistoryInput = z.infer<typeof agentProfileHistorySchema>

/** agent_profile_restore (S1 R2) — roll one profile doc back to a history version
 *  (target_hash = a version_hash from agent_profile_history). Edit-tier write. */
export const agentProfileRestoreSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory']),
  target_hash: z.string().min(1).max(128)
})
export type AgentProfileRestoreInput = z.infer<typeof agentProfileRestoreSchema>

/** agent_memory_update (S1 R2) — propose new full content for memory.md (bounded memory;
 *  the Python endpoint enforces the hard character budget). Edit-tier write. */
export const agentMemoryUpdateSchema = z.object({
  content: z.string().min(1)
})
export type AgentMemoryUpdateInput = z.infer<typeof agentMemoryUpdateSchema>

// ── chat-session schemas (S1 R1) — the agent reads its own past conversations. Behind
//    MAILAGENT_OPENNESS_SESSION_TOOLS. All three are silent reads; returned message content
//    is untrusted (past sessions embed email bodies) and is CHAT_HISTORY-fenced by the tools. ──

/** chat_session_list — recent chat sessions (metadata + first-message preview). */
export const chatSessionListSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20)
})
export type ChatSessionListInput = z.infer<typeof chatSessionListSchema>

/** chat_session_search — full-text search over past chat messages (query required). */
export const chatSessionSearchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10)
})
export type ChatSessionSearchInput = z.infer<typeof chatSessionSearchSchema>

/** chat_session_get — read one past session's messages (recent window, capped). */
export const chatSessionGetSchema = z.object({
  session_id: z.number().int(),
  limit: z.number().int().min(1).max(100).default(30)
})
export type ChatSessionGetInput = z.infer<typeof chatSessionGetSchema>

// ── web schemas (S1 R3) — the agent fetches a web page / searches the web. Behind
//    MAILAGENT_OPENNESS_WEB_TOOLS. BOTH are edit-tier writes (outbound network = always ask,
//    editable url/query). Returned content is untrusted → the tools WEB_CONTENT-fence it.
//    Python (routers/web.py) is the execution authority (SSRF guard, IP pinning). ──────────

/** web_fetch (S1 R3) — fetch one http/https URL's readable content. max_chars caps the
 *  extracted text (server clamps to its own hard max). */
export const webFetchSchema = z.object({
  url: z.string().min(1).max(4096),
  max_chars: z.number().int().min(200).max(200_000).default(50_000)
})
export type WebFetchInput = z.infer<typeof webFetchSchema>

/** web_search (S1 R3) — DuckDuckGo web search (best-effort). limit caps result count. */
export const webSearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5)
})
export type WebSearchInput = z.infer<typeof webSearchSchema>

// ── exec schemas (S2 W1) — the agent runs a local command / reads / writes a file. Behind
//    MAILAGENT_OPENNESS_EXEC_TOOLS. ALL THREE are edit-tier writes (local execution = always ask
//    unless a structured whitelist rule the user set matches; never auto-approved). Field names
//    mirror the Python execution endpoints (routers/exec.py: /api/exec/{run,file_read,file_write}).
//    Python is the execution authority (fixed env allowlist, inode-level deny floor, no shell). ──

/** run_command (S2 W1) — run ONE local command with an explicit argv (NO shell — argv[0] is the
 *  program, the rest are literal arguments; shell metacharacters are NOT interpreted). cwd is an
 *  optional absolute working directory. timeout_ms bounds the run (server clamps to its own max). */
export const execRunCommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1).max(600_000).default(60_000)
})
export type ExecRunCommandInput = z.infer<typeof execRunCommandSchema>

/** file_read (S2 W1) — read a local file's text content. max_bytes caps the returned content
 *  (server clamps to its own hard max). Sensitive targets (.env / *.db / token.dat / ssh keys /
 *  the app bundle) are refused server-side (inode-level deny floor). */
export const execFileReadSchema = z.object({
  path: z.string().min(1),
  max_bytes: z.number().int().min(1).max(2_097_152).default(262_144)
})
export type ExecFileReadInput = z.infer<typeof execFileReadSchema>

/** file_write (S2 W1) — write text to a local file. mode: create_new (default — fails if the file
 *  exists), overwrite (replace), or append. The parent directory must already exist (not created).
 *  Sensitive targets are refused server-side (inode-level deny floor). */
export const execFileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(['overwrite', 'append', 'create_new']).default('create_new')
})
export type ExecFileWriteInput = z.infer<typeof execFileWriteSchema>
