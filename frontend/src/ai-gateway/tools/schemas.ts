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

/** email_list_filter — metadata filter (subject/sender/date/flags). All optional. */
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

/** email_thread_attachments — every attachment across a thread (metadata + provenance). Mirrors
 *  email_list_thread's single thread_id input. */
export const emailThreadAttachmentsSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailThreadAttachmentsInput = z.infer<typeof emailThreadAttachmentsSchema>

/** email_attachment_text — extracted text of one attachment (capped, clip mode mirrors email_body). */
export const emailAttachmentTextSchema = z.object({
  attachment_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000)
})
export type EmailAttachmentTextInput = z.infer<typeof emailAttachmentTextSchema>

/** kos_query — cross-domain KOS retrieval. */
export const kosQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).default(10),
  expand: z.boolean().default(false),
  source_id: z.string().optional()
})
export type KosQueryInput = z.infer<typeof kosQuerySchema>

// ── extra KOS read tools (issue #57) — keyword full-text / page read / expert lookup /
//    page listing / backlinks. All proxy through domain.kosCall(<mcp name>, args) to the
//    generic serve-api /chat/kos-call passthrough (KOSClient.call_tool) — zero new Python.
//    All silent reads (no write tool is registered). ──────────────────────────────────────

/** kos_search — keyword full-text search (a lighter, faster sibling of kos_query).
 *  NO `mode`: KOS's own tools/list documents it as "Local callers only" and a live probe
 *  (v0.42.64.0) returned byte-identical hits + scores for every value incl. garbage — an
 *  optional param the model believes tunes the search but cannot is exactly the #57 bug. */
export const kosSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosSearchInput = z.infer<typeof kosSearchSchema>

/** kos_get_page — read one page's full content by slug (fuzzy = tolerate near-miss slugs). */
export const kosGetPageSchema = z.object({
  slug: z.string().min(1),
  fuzzy: z.boolean().optional()
})
export type KosGetPageInput = z.infer<typeof kosGetPageSchema>

/** kos_find_experts — "who knows X" — people/concepts related to a topic (with scores). */
export const kosFindExpertsSchema = z.object({
  topic: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosFindExpertsInput = z.infer<typeof kosFindExpertsSchema>

/** kos_list_pages — list people/concept/etc. pages (all filters optional). `sort` is the
 *  KOS enum (tools/list): a free-form string silently falls back to updated_desc, so the
 *  model must not be able to invent one. `type` stays open (the brain grows types —
 *  person/company/concept/project/note/email/source/atom/… all observed live). */
export const kosListPagesSchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  updated_after: z.string().optional(),
  sort: z.enum(['updated_desc', 'updated_asc', 'created_desc', 'slug']).optional()
})
export type KosListPagesInput = z.infer<typeof kosListPagesSchema>

/** kos_get_backlinks — pages/people that reference a given page (empty = no edges yet).
 *  `limit` is applied CLIENT-side: KOS's get_backlinks takes only {slug} and returns the
 *  full edge set (a live probe returned 337 rows / 65KB for one person page), which would
 *  dump ~16k tokens of third-party text into the context on a single call. */
export const kosGetBacklinksSchema = z.object({
  slug: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50)
})
export type KosGetBacklinksInput = z.infer<typeof kosGetBacklinksSchema>

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

/** email_draft_reply — compose a reply / reply-all draft. Recipients default to
 *  server-derived reply-all; optional to/cc/bcc OVERRIDE the full lists (the way to
 *  add/remove people on top of reply-all — compute the final lists from the source
 *  email's sender/to/cc and pass them explicitly). */
export const emailDraftReplySchema = z.object({
  internal_id: z.number().int(),
  body_markdown: z.string().min(1),
  mode: z.enum(['reply', 'reply-all']).optional(),
  to: z.array(z.string().min(3)).optional(),
  cc: z.array(z.string().min(3)).optional(),
  bcc: z.array(z.string().min(3)).optional()
})
export type EmailDraftReplyInput = z.infer<typeof emailDraftReplySchema>

/** email_draft_compose (prd 07-27 C-3) — a BRAND-NEW draft (`mode:'new'`) or a forward of an
 *  existing email (`mode:'forward'`). Unlike the "at least one of …" checks that live in `run`,
 *  the cross-field rules sit in `.superRefine` so an impossible combination fails BEFORE the
 *  approval card is shown (showing the user a card for a call that can only error is worse than a
 *  validation retry the model fixes itself):
 *    - forward REQUIRES internal_id (the source email) + at least one recipient (the service
 *      rejects a recipient-less forward too);
 *    - 'new' REJECTS internal_id — a new draft has no source email, so passing one means the
 *      model meant forward (or email_draft_reply).
 *  quote_original is forward-only (a new draft has nothing to quote); default true. */
export const emailDraftComposeSchema = z
  .object({
    mode: z.enum(['new', 'forward']),
    internal_id: z.number().int().optional(),
    subject: z.string().optional(),
    body_markdown: z.string().min(1),
    to: z.array(z.string().min(3)),
    cc: z.array(z.string().min(3)).optional(),
    bcc: z.array(z.string().min(3)).optional(),
    quote_original: z.boolean().optional()
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'forward') {
      if (v.internal_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['internal_id'],
          message: "mode 'forward' requires internal_id (the source email to forward)"
        })
      }
      if (v.to.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: "mode 'forward' requires at least one recipient in `to`"
        })
      }
    } else if (v.internal_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['internal_id'],
        message:
          "mode 'new' takes no internal_id (a new draft has no source email — use mode 'forward' to forward one, or email_draft_reply to reply to one)"
      })
    }
  })
export type EmailDraftComposeInput = z.infer<typeof emailDraftComposeSchema>

/** email_draft_update (prd 07-27 C-4) — edit an EXISTING draft by its internal_id. Every content
 *  field is optional: an omitted field is backfilled from the current draft, so a subject-only
 *  edit keeps the body/recipients as they are. "at least one field must change" is enforced in
 *  `run` (email_flag precedent — the semantic check keeps the legacy E_INVALID_ARG error shape). */
export const emailDraftUpdateSchema = z.object({
  draft_internal_id: z.number().int(),
  subject: z.string().optional(),
  body_markdown: z.string().min(1).optional(),
  to: z.array(z.string().min(3)).optional(),
  cc: z.array(z.string().min(3)).optional(),
  bcc: z.array(z.string().min(3)).optional()
})
export type EmailDraftUpdateInput = z.infer<typeof emailDraftUpdateSchema>

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

/** notion_agent_chat (task 07-21) — delegate a Notion-workspace request to the notion-agent CLI.
 *  `prompt` is the natural-language ask (question OR task); `thread_id` continues a prior Notion
 *  conversation; `model` overrides the bound default. Field names mirror the Python builtin skill
 *  tool schema (src/skills/builtin/notion_agent.py) so the gateway → /api/skills/invoke body matches. */
export const notionAgentChatSchema = z.object({
  prompt: z.string().min(1).max(8000),
  thread_id: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional()
})
export type NotionAgentChatInput = z.infer<typeof notionAgentChatSchema>

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

// ── skill-supply schemas (S2 W4) — the agent installs / uninstalls / reads third-party skill
//    packages. Behind MAILAGENT_OPENNESS_SKILL_INSTALL. install / confirm / uninstall are
//    edit-tier writes + class capability_change (ALWAYS ask — never auto-approved, never
//    whitelist-relaxed; ADR-001 D3 row); skill_read is a silent read whose returned SKILL.md is
//    UNTRUSTED_SKILL_DOC-fenced by the tool (third-party text = injection surface, ADR-002 D4).
//    Python (routers/agent.py + skills/pack_fetch|pack_verify) is the business authority
//    (SSRF-hardened download, safe unpack, real hash, confirm re-hash TOCTOU guard). ──────────

/** skill_install (S2 W4) — stage one of the two-step install: fetch a skill package (from a URL
 *  or a local path, exactly one) into QUARANTINE. Nothing is installed yet — the server returns
 *  a preview (quarantine id + hashes + manifest summary) for the user to review. */
export const skillInstallSchema = z.object({
  source_url: z.string().min(1).max(4096).optional(),
  local_path: z.string().min(1).max(4096).optional()
})
export type SkillInstallInput = z.infer<typeof skillInstallSchema>

/** skill_install_confirm (S2 W4) — stage two: really install a quarantined package. The
 *  expected_package_hash / expected_files MUST be echoed verbatim from the skill_install preview
 *  — the server re-hashes the quarantine content and rejects (409) on any mismatch (TOCTOU
 *  guard), so a forged hash only defeats the install. */
export const skillInstallConfirmSchema = z.object({
  quarantine_id: z.string().min(1).max(64),
  expected_package_hash: z.string().min(1).max(128),
  expected_files: z.record(z.string(), z.string()).optional()
})
export type SkillInstallConfirmInput = z.infer<typeof skillInstallConfirmSchema>

/** skill_uninstall (S2 W4) — full-cleanup uninstall: DB row + on-disk directory + stored
 *  secrets all go (POST /agent/skills/uninstall — NEVER the legacy row-only DELETE). */
export const skillUninstallSchema = z.object({
  name: z.string().min(1).max(64)
})
export type SkillUninstallInput = z.infer<typeof skillUninstallSchema>

/** skill_read (S2 W4) — read an installed skill's SKILL.md (fenced + truncated by the tool). */
export const skillReadSchema = z.object({
  name: z.string().min(1).max(64)
})
export type SkillReadInput = z.infer<typeof skillReadSchema>

// ── custom-agent CRUD schemas (S5 W3; grants opened S6 W3-2) — the assistant helps the owner
//    build / edit / run a custom agent through conversation. Behind MAILAGENT_CUSTOM_AGENTS_ENABLED.
//    list/get are silent reads; create/update/delete/run_now are edit-tier writes (class
//    capability_change — always ask, never auto-approved). Deep validation lives in Python
//    (validate_agent_config_patch); the gateway schema is an ALLOWLIST and `.strict()` rejects any
//    unknown key. ADR-004 rev3.1 §7 (owner Q4) opened grant_exec / grant_web / skills into this
//    vocabulary: the model may PROPOSE grants, but every create/update is pinned behind a mandatory
//    approval card whose permission summary renders them red — the defense moved from field-level
//    deny to the always-human card. tool_policy / policy_rules / any raw policy field still
//    structurally cannot enter (rule creation stays owner-only). ──

/** A custom-agent trigger the model may propose. Mirrors CustomAgentTrigger (backend
 *  src/agents/trigger.py is the validation authority: cron 5-field + croniter, regex ReDoS caps).
 *  The `v` version bit is added by the wire construction, not the model. */
export const customAgentTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      cron: z.string().min(1).max(256),
      timezone: z.string().max(64).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('email_filter'),
      subject_pattern: z.string().max(256).optional(),
      sender_pattern: z.string().max(256).optional(),
      folders: z.array(z.string().min(1).max(200)).max(32).optional()
    })
    .strict()
])
export type CustomAgentTriggerInput = z.infer<typeof customAgentTriggerSchema>

/** A custom-agent budget the model may propose (three run gates). Mirrors CustomAgentBudget; the
 *  backend clamps each field defensively (parse_budget) — these bounds match the backend ceilings. */
export const customAgentBudgetSchema = z
  .object({
    max_steps: z.number().int().min(1).max(16).optional(),
    max_runs_per_day: z.number().int().min(0).max(100_000).optional(),
    max_run_seconds: z.number().int().min(1).max(1800).optional()
  })
  .strict()
export type CustomAgentBudgetInput = z.infer<typeof customAgentBudgetSchema>

/** custom_agent_list — list the owner's custom agents (silent read). */
export const customAgentListSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50)
})
export type CustomAgentListInput = z.infer<typeof customAgentListSchema>

/** custom_agent_get — one custom agent's full spec + recent runs (silent read). */
export const customAgentGetSchema = z.object({
  agent_id: z.string().min(1).max(128),
  runs_limit: z.number().int().min(0).max(20).default(5)
})
export type CustomAgentGetInput = z.infer<typeof customAgentGetSchema>

/** The per-agent web grant tier (ADR-004 rev3.1 §3.1): off = web tools absent headless; gated =
 *  registered, web_fetch card-free only on the owner's per-agent domain whitelist; open = any URL
 *  card-free. Proposing 'gated'/'open' is allowed — the approval card renders it red ('open'). */
export const customAgentWebGrantSchema = z.enum(['off', 'gated', 'open'])

/** custom_agent_create — propose a new custom agent (edit-tier write). ALLOWLIST: title / prompt /
 *  model / enabled / trigger / allowed_tools / budget + (rev3.1 §7) grant_exec / grant_web / skills.
 *  `.strict()` rejects any other key — tool_policy / policy_rules stay structurally out: the model
 *  may propose grants (surfaced red on the mandatory approval card) but has NO rule-creation path. */
export const customAgentCreateSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().max(20_000).optional(),
    model: z.string().max(128).optional(),
    enabled: z.boolean().optional(),
    trigger: customAgentTriggerSchema.nullable().optional(),
    allowed_tools: z.array(z.string().min(1).max(64)).max(64).optional(),
    budget: customAgentBudgetSchema.nullable().optional(),
    grant_exec: z.boolean().optional(),
    grant_web: customAgentWebGrantSchema.optional(),
    skills: z.array(z.string().min(1).max(64)).max(32).optional()
  })
  .strict()
export type CustomAgentCreateInput = z.infer<typeof customAgentCreateSchema>

/** custom_agent_update — propose changes to an existing custom agent (edit-tier write). Same
 *  ALLOWLIST as create (minus id, plus agent_id); every config field optional (partial patch).
 *  `.strict()` keeps tool_policy / policy fields structurally out; grant/skill changes render as a
 *  before/after diff on the approval card (before = the SERVER's current row, never model input). */
export const customAgentUpdateSchema = z
  .object({
    agent_id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().max(20_000).nullable().optional(),
    model: z.string().max(128).optional(),
    enabled: z.boolean().optional(),
    trigger: customAgentTriggerSchema.nullable().optional(),
    allowed_tools: z.array(z.string().min(1).max(64)).max(64).optional(),
    budget: customAgentBudgetSchema.nullable().optional(),
    grant_exec: z.boolean().optional(),
    grant_web: customAgentWebGrantSchema.optional(),
    skills: z.array(z.string().min(1).max(64)).max(32).optional()
  })
  .strict()
export type CustomAgentUpdateInput = z.infer<typeof customAgentUpdateSchema>

/** custom_agent_delete — delete a custom agent by id (edit-tier write). */
export const customAgentDeleteSchema = z.object({
  agent_id: z.string().min(1).max(128)
})
export type CustomAgentDeleteInput = z.infer<typeof customAgentDeleteSchema>

/** custom_agent_run_now — enqueue one immediate run of a custom agent (edit-tier write). */
export const customAgentRunNowSchema = z.object({
  agent_id: z.string().min(1).max(128)
})
export type CustomAgentRunNowInput = z.infer<typeof customAgentRunNowSchema>

// ── calendar schemas (calendar epic 4.1/4.2) — the agent reads the local calendar SSoT and
//    proposes reschedule / RSVP / delete. Behind MAILAGENT_CALENDAR_AGENT_TOOLS. Reads are silent
//    (summary/description/location/organizer come back CALENDAR_EVENT-fenced — meeting invites are
//    externally-authored text); the three writes are edit-tier, ALWAYS ask (D4: 恒 HITL — never
//    auto-approved, no whitelist hook). P2-4: date/datetime params accept an IANA `timezone` and
//    date-only / offset-less values are interpreted in it (default: the machine's local timezone,
//    NEVER UTC — a UTC "today" is 7-8h off for a US-west user). ──────────────────────────────────

/** calendar_events_list — occurrences in a window (RRULE expanded server-side). */
export const calendarEventsListSchema = z.object({
  from_date: z.string().min(1).max(64).optional(),
  to_date: z.string().min(1).max(64).optional(),
  days: z.number().int().min(1).max(60).default(7),
  timezone: z.string().min(1).max(64).optional(),
  calendar_name: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50)
})
export type CalendarEventsListInput = z.infer<typeof calendarEventsListSchema>

/** calendar_event_get — one event's full detail by iCalendar UID. */
export const calendarEventGetSchema = z.object({
  event_id: z.string().min(1).max(512),
  source: z.enum(['caldav', 'email_ics', 'legacy_calendar_app']).default('caldav'),
  recurrence_id: z.string().min(1).max(64).optional()
})
export type CalendarEventGetInput = z.infer<typeof calendarEventGetSchema>

/** calendar_event_reschedule — move an event (whole series / this occurrence / this-and-future). */
export const calendarEventRescheduleSchema = z.object({
  event_id: z.string().min(1).max(512),
  new_start: z.string().min(1).max(64),
  new_end: z.string().min(1).max(64),
  scope: z.enum(['series', 'occurrence', 'future']).default('series'),
  recurrence_id: z.string().min(1).max(64).optional(),
  timezone: z.string().min(1).max(64).optional()
})
export type CalendarEventRescheduleInput = z.infer<typeof calendarEventRescheduleSchema>

/** calendar_event_rsvp — send the IRREVOCABLE iTIP REPLY to the organizer. */
export const calendarEventRsvpSchema = z.object({
  event_id: z.string().min(1).max(512),
  response: z.enum(['accept', 'tentative', 'decline']),
  recurrence_id: z.string().min(1).max(64).optional()
})
export type CalendarEventRsvpInput = z.infer<typeof calendarEventRsvpSchema>

/** calendar_event_delete — CalDAV DELETE (irreversible). */
export const calendarEventDeleteSchema = z.object({
  event_id: z.string().min(1).max(512),
  calendar_name: z.string().min(1).max(200).optional()
})
export type CalendarEventDeleteInput = z.infer<typeof calendarEventDeleteSchema>
