// S2 W1 (task 07-02-s2-exec-skill-install, ADR-001) — exec tools: the agent runs a local command
// and reads / writes files. All three go through serve-api /exec/* (Python is the execution
// authority: fixed env allowlist that never inherits global secrets + inode-level deny floor +
// NO shell — the gateway core NEVER touches child_process/fs).
//
// Three EDIT-TIER writes behind MAILAGENT_OPENNESS_EXEC_TOOLS (default OFF — island 模式: ship off
// → dogfood → cutover 另拍):
//   - run_command (edit-tier, class exec) — run ONE local command (explicit argv, no shell)
//   - file_read   (edit-tier, class exec) — read a local file's text
//   - file_write  (edit-tier, class exec) — write text to a local file
//
// 🔴 Why edit-tier + class exec (ADR-001 D2/D3): local execution is the lethal-trifecta hinge. tier
//    'edit' owns the approval-card UX (always a card, never the approvalMode auto-reversible skip);
//    class 'exec' owns POLICY — manual_chat-ONLY (outside a manual session the tool is neither
//    registered nor executable, applyContextModePolicy + the runtime double-insurance in types.ts).
//    So an agent steered by a poisoned email can never reach these tools at all in a future
//    email-triggered run, and in a manual session every run is a card the user sees.
//
// 🔴 Structured whitelist (NOT auto-reversible): each tool's needsApproval consults
//    /api/agent/policy/evaluate with the run's SERVER-ASSERTED contextMode (never a body value) and
//    an action descriptor derived from THIS call. A matching PolicyRule the user set (via the
//    approval card's "always allow" affordance or Settings) → auto_allow → the card is skipped and
//    the audit records approval_status='auto_whitelist' + the rule id. Any other verdict / a
//    timeout / an error → the card (fail-closed). Rules are structured (argv template + realpath
//    scope), never string prefixes, and are created ONLY by an explicit owner action — no tool.
//
// 🔴 No sandbox (honest): an approved run_command executes with the owner's full file permissions.
//    The system's defence is HITL + whitelist narrowness + the fixed env allowlist (no global
//    secrets to echo) + the inode deny floor on file_read/file_write — NOT process isolation. This
//    is carried by the approval card copy, not over-promised in the tool descriptions.
//
// CORE (skill_gating.CORE_UNGATED_GATEWAY_TOOLS): the on/off authority is the flag, never skill gating.

import type { Tool } from 'ai'
import type { z } from 'zod'

import type { MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { auditedWriteTool, type GatewayApprovalMode, type GatewayToolAuditCollector } from './types'
import { normalizeContextMode, type AgentContextMode } from './policy'
import { execRunCommandSchema, execFileReadSchema, execFileWriteSchema } from './schemas'

/** Names of the exec tools the gateway exposes when MAILAGENT_OPENNESS_EXEC_TOOLS is on. Exported
 *  for tests + the eval catalog completeness gate (which statically extracts every
 *  GATEWAY_*_TOOL_NAMES array). */
export const GATEWAY_EXEC_TOOL_NAMES = ['run_command', 'file_read', 'file_write'] as const

/**
 * Build the S2 W1 exec tools bound to the injected domain client + audit collector + approval
 * guard. All three are edit-tier writes whose needsApproval consults the structured whitelist
 * (auto_allow → skip the card; else → the card). contextMode is the run's server-asserted mode.
 */
export function createExecTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  // The whitelist evaluate MUST use the run's server-asserted context mode (fail-closed normalize),
  // never a request-body value. exec is manual-only, so in practice this is 'manual_chat' whenever
  // policyEvaluate actually runs (a non-manual run is modeDenied before needsApproval reaches it).
  const contextMode = normalizeContextMode(opts.contextMode)

  const makeExec = <I>(toolOpts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    editableFields?: readonly string[]
    /** capability + action descriptor for the whitelist evaluate (per-tool). */
    capability: string
    toAction: (input: I) => Record<string, unknown>
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      {
        name: toolOpts.name,
        description: toolOpts.description,
        inputSchema: toolOpts.inputSchema,
        // edit tier — always a card, never the approvalMode auto-reversible skip (ADR-001 D3).
        risk: 'edit',
        editableFields: toolOpts.editableFields,
        a2uiEnabled: opts.a2uiEnabled,
        // approvalMode is intentionally NOT threaded — exec tools relax ONLY via policyEvaluate.
        oneShot: opts.oneShot,
        // S2 W0 — class exec (policy.ts): manual_chat-only, never auto-approved.
        contextMode: opts.contextMode,
        // S2 W1 — the structured whitelist hook. A matching rule → auto_allow → skip the card;
        // ask / error → the card (fail-closed). Uses the closure-captured server contextMode.
        policyEvaluate: (input) =>
          domain.policyEvaluate(toolOpts.capability, toolOpts.toAction(input), contextMode),
        run: toolOpts.run
      },
      collector,
      guard
    )

  // EDIT-tier write — run ONE local command (no shell). editableFields=['argv','cwd'] so the user
  // can correct the command / working directory at approval time.
  const run_command = makeExec({
    name: 'run_command',
    description:
      'Run ONE local command on the machine with an explicit argv (argv[0] is the program, the ' +
      'rest are literal arguments — there is NO shell, so pipes / redirects / globs / && are NOT ' +
      'interpreted; run one program per call). Optionally set cwd (an absolute working directory) ' +
      'and timeout_ms. The user must approve every run and may edit the argv / cwd first (they can ' +
      'also choose to always allow a matching command). stdout and stderr are returned (each ' +
      'truncated if large). Use this for local tooling the user asked for; do NOT use it to read ' +
      'sensitive files — private files (.env, databases, keys) are refused by file_read and reading ' +
      'them here is a misuse. Edit tier — always asks unless the user allow-listed this exact command.',
    inputSchema: execRunCommandSchema,
    editableFields: ['argv', 'cwd'],
    capability: 'exec',
    toAction: (input) => ({ argv: input.argv, cwd: input.cwd ?? null }),
    run: async (input, { userEdited, signal }) => {
      const r = await domain.runCommand(
        input.argv,
        { cwd: input.cwd, timeoutMs: input.timeout_ms },
        signal
      )
      return {
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
        duration_ms: r.duration_ms,
        cwd: r.cwd,
        // floor_hit is an informational "this touched a sensitive path" flag (the run was NOT
        // blocked — run_command has no filesystem sandbox); surface it so the model knows.
        floor_hit: r.floor_hit,
        user_edited: userEdited
      }
    }
  })

  // EDIT-tier write — read a local file's text. editableFields=['path'] so the user can correct
  // the target at approval time.
  const file_read = makeExec({
    name: 'file_read',
    description:
      "Read a local file's text content (up to max_bytes; long files are truncated). Give an " +
      'absolute path. The user must approve the read and may edit the path first. Sensitive files ' +
      '(.env, *.db, token.dat, ssh keys, the app bundle) are refused by the server — do not try to ' +
      'read secrets. Edit tier — always asks unless the user allow-listed this directory.',
    inputSchema: execFileReadSchema,
    editableFields: ['path'],
    capability: 'file_read',
    toAction: (input) => ({ path: input.path }),
    run: async (input, { userEdited, signal }) => {
      const r = await domain.fileRead(input.path, input.max_bytes, signal)
      return {
        content: r.content,
        truncated: r.truncated,
        size: r.size,
        user_edited: userEdited
      }
    }
  })

  // EDIT-tier write — write text to a local file. editableFields=['path','content'] so the user can
  // correct the target / content at approval time.
  const file_write = makeExec({
    name: 'file_write',
    description:
      'Write text to a local file. Give an absolute path and the full content. mode: create_new ' +
      '(default — fails if the file already exists), overwrite (replace the whole file), or append. ' +
      'The parent directory must already exist (it is NOT created). The user must approve the write ' +
      'and may edit the path / content first. Sensitive targets are refused by the server. Edit ' +
      'tier — always asks unless the user allow-listed this directory.',
    inputSchema: execFileWriteSchema,
    editableFields: ['path', 'content'],
    capability: 'file_write',
    toAction: (input) => ({ path: input.path }),
    run: async (input, { userEdited, signal }) => {
      const r = await domain.fileWrite(input.path, input.content, input.mode, signal)
      return {
        bytes_written: r.bytes_written,
        created: r.created,
        user_edited: userEdited
      }
    }
  })

  return { run_command, file_read, file_write }
}
