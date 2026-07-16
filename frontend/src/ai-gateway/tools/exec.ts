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
import { normalizeContextMode, type AgentContextMode, type AgentRunContext } from './policy'
import { execRunCommandSchema, execFileReadSchema, execFileWriteSchema } from './schemas'
// D4-① (ADR-004 §6, unflagged security fix) — exec output is the ONLY un-reviewed model input in a
// whitelist-skipped run: fence stdout/stderr/file content like every other untrusted tool output
// (same helper as web/sessions, whose sanitizeUntrusted breaks fence tokens with a ZWSP — the
// contextSerializer double-replace discipline).
import { fenceUntrusted } from '../../shared/assistant/context/contextSerializer'

/** Wrap a non-empty exec output string in the UNTRUSTED_EXEC_OUTPUT fence; empty stays empty
 *  (mirrors web.ts' title handling — no fence noise around nothing). */
function fenceExecOutput(text: string, part: string): string {
  return text.length > 0 ? fenceUntrusted('EXEC_OUTPUT', text, { part }) : text
}

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
    /** S5 W4 (ADR-004 D2) — the per-agent run context of a headless agent run: modeGrants feeds
     *  the runtime modeDenied (same isToolClassAllowedInMode + same grants object as the
     *  registration filter), agentId keys the per-agent whitelist evaluate and stamps the /exec/*
     *  audit annotation. Absent (manual) → everything below is byte-identical to S2. */
    agentRunContext?: AgentRunContext
  } = {}
): Record<string, Tool> {
  // The whitelist evaluate MUST use the run's server-asserted context mode (fail-closed normalize),
  // never a request-body value. Pre-ADR-004 exec was manual-only; a headless agent run reaches
  // these tools only through the matrix's per-agent exec grant, and then the evaluate carries the
  // REAL contextMode + agentId (without them Python would fall back to the manual global
  // candidates → always ask, ADR-004 §4.1).
  const contextMode = normalizeContextMode(opts.contextMode)
  const agentId = opts.agentRunContext?.agentId
  // Audit annotation for /exec/* (PURE annotation — the endpoint never gates on it): only a
  // headless agent run stamps it; manual keeps the S2 body byte-identical.
  const execAudit = agentId != null ? { contextMode, agentId } : undefined

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
        // 07-16 approval-mode switcher — approvalMode is now threaded, but ONLY the owner-global
        // modes can ever relax an exec tool ('auto-reversible' still can't: exec is edit-tier +
        // class exec). 'bypass' skips the card for all three; 'acceptEdits' skips it for
        // file_read/file_write (in the fail-closed ACCEPT_EDITS_AUTO_APPROVE_TOOLS allow-list,
        // policy.ts) while run_command is deliberately NOT listed and keeps the whitelist-or-card
        // path below (exec 非白名单恒 HITL, owner 拍板).
        approvalMode: opts.approvalMode,
        oneShot: opts.oneShot,
        // S2 W0 — class exec (policy.ts): manual_chat-only unless per-agent granted (ADR-004 D2).
        contextMode: opts.contextMode,
        // S5 W4 — the same grants the registration filter consumed, for the runtime modeDenied.
        modeGrants: opts.agentRunContext?.modeGrants,
        // S2 W1 — the structured whitelist hook. A matching rule → auto_allow → skip the card;
        // ask / error → the card (fail-closed). Uses the closure-captured server contextMode.
        // S2 W4 (W1b review P3-1) — a 2.5s abort so a hung loopback degrades to the card in
        // bounded time instead of suspending needsApproval forever (the .catch(() => true) in
        // types.ts turns the AbortError into "show the card" — fail-closed semantics unchanged).
        // S5 W4 — agentId keys the per-agent candidate set for a headless run (absent → manual
        // global candidates, byte-identical body).
        policyEvaluate: (input) =>
          domain.policyEvaluate(
            toolOpts.capability,
            toolOpts.toAction(input),
            contextMode,
            AbortSignal.timeout(2500),
            agentId
          ),
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
        signal,
        execAudit
      )
      return {
        exit_code: r.exit_code,
        // D4-① — a third-party program's output is untrusted model input (the head injection
        // surface once a whitelist rule skips the card): fenced, never raw bytes.
        stdout: fenceExecOutput(r.stdout, 'stdout'),
        stderr: fenceExecOutput(r.stderr, 'stderr'),
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
      const r = await domain.fileRead(input.path, input.max_bytes, signal, execAudit)
      return {
        // D4-① — file content is third-party text like a web page: fenced, never raw.
        content: fenceExecOutput(r.content, 'content'),
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
      const r = await domain.fileWrite(input.path, input.content, input.mode, signal, execAudit)
      return {
        bytes_written: r.bytes_written,
        created: r.created,
        user_edited: userEdited
      }
    }
  })

  return { run_command, file_read, file_write }
}
