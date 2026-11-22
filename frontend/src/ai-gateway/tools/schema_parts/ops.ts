// Plan, self-mount, profile, session-read, web, exec, and skill-supply schemas.
import { z } from 'zod'

export const PLAN_STEP_STATUSES = [
  'pending',
  'in_progress',
  'done',
  'blocked',
  'unavailable'
] as const

/** plan_update — local, side-effect-free plan artifact. */
export const planUpdateSchema = z
  .object({
    goal: z.string().trim().min(1),
    steps: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1),
          status: z.enum(PLAN_STEP_STATUSES),
          note: z.string().trim().optional()
        })
      )
      .max(12)
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'step id must be unique within a plan',
          path: ['steps', index, 'id']
        })
      }
      seen.add(step.id)
    })
  })
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>

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
const sessionQueryFields = {
  origin: z.enum(['interactive', 'agent', 'im', 'team', 'group', 'all']).optional(),
  agentId: z.string().min(1).optional(),
  agentJobId: z.string().min(1).optional(),
  triggerId: z.string().min(1).optional(),
  triggerKind: z.string().min(1).optional(),
  createdAfter: z.number().int().optional(),
  createdBefore: z.number().int().optional(),
  archived: z.boolean().optional(),
  starred: z.boolean().optional()
}
export const chatSessionListProvenanceSchema = chatSessionListSchema.extend(sessionQueryFields)
export type ChatSessionListInput = z.infer<typeof chatSessionListSchema>

/** chat_session_search — full-text search over past chat messages (query required). */
export const chatSessionSearchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10)
})
export const chatSessionSearchProvenanceSchema = chatSessionSearchSchema.extend(sessionQueryFields)
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
  local_path: z.string().min(1).max(4096).optional(),
  skill_name: z.string().min(1).max(64).optional()
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

/** skill_read_resource — read, list, or search bundled files inside an installed/builtin skill. */
export const skillReadResourceSchema = z.object({
  name: z.string().min(1).max(64),
  path: z.string().min(1).max(512).optional(),
  search: z.string().min(1).max(256).optional(),
  json_path: z.string().min(1).max(256).optional(),
  offset_line: z.number().int().min(1).optional(),
  max_lines: z.number().int().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(50).optional()
})
export type SkillReadResourceInput = z.infer<typeof skillReadResourceSchema>

export const skillDraftCreateSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  manifest: z.record(z.string(), z.unknown()).optional()
})
export type SkillDraftCreateInput = z.infer<typeof skillDraftCreateSchema>

export const skillDraftWriteFileSchema = z.object({
  draftId: z.string().min(1).max(64),
  path: z.string().min(1).max(512),
  content: z.string().max(1024 * 1024)
})
export type SkillDraftWriteFileInput = z.infer<typeof skillDraftWriteFileSchema>

export const skillDraftReadSchema = z.object({
  draftId: z.string().min(1).max(64),
  path: z.string().min(1).max(512).optional()
})
export type SkillDraftReadInput = z.infer<typeof skillDraftReadSchema>

export const skillDraftValidateSchema = z.object({
  draftId: z.string().min(1).max(64)
})
export type SkillDraftValidateInput = z.infer<typeof skillDraftValidateSchema>

export const skillDraftPublishSchema = z.object({
  draftId: z.string().min(1).max(64),
  enabled: z.boolean().default(true)
})
export type SkillDraftPublishInput = z.infer<typeof skillDraftPublishSchema>

export const skillDraftDiscardSchema = z.object({
  draftId: z.string().min(1).max(64)
})
export type SkillDraftDiscardInput = z.infer<typeof skillDraftDiscardSchema>
