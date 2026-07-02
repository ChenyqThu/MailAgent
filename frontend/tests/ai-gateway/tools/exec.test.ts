// S2 W1 (task 07-02-s2-exec-skill-install) — exec tools: flag gate (byte-identical off), edit-tier
// writes that ALWAYS ask UNLESS the structured whitelist (/api/agent/policy/evaluate) returns
// auto_allow, whitelist免卡 audit (approval_status='auto_whitelist' + whitelist_rule_id), fail-closed
// (evaluate ask / error → the card), identity pin (a raw-changed exec input → E_APPROVAL_HASH_MISMATCH,
// no run), and the runtime context-mode double-insurance (exec is manual_chat-only).

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createExecTools, GATEWAY_EXEC_TOOL_NAMES } from '../../../src/ai-gateway/tools/exec'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope, errEnvelope } from './_helpers'

const RUN_RESULT = {
  exit_code: 0,
  stdout: 'hello\n',
  stderr: '',
  truncated: false,
  duration_ms: 3,
  cwd: '/work',
  floor_hit: false,
  floor_hits: [],
  policy: { decision: 'ask', rule_id: null }
}
const FILE_READ_RESULT = {
  content: 'file body',
  truncated: false,
  size: 9,
  policy: { decision: 'ask', rule_id: null }
}
const FILE_WRITE_RESULT = {
  bytes_written: 4,
  created: true,
  policy: { decision: 'ask', rule_id: null }
}

/** Mock domain covering /exec/* + /agent/policy/evaluate. `verdict` sets the whitelist decision;
 *  overrides let a test inject an error / capture the wire body. */
function execDomain(overrides?: {
  verdict?: { decision: 'auto_allow' | 'ask'; rule_id: number | null }
  evaluateThrows?: boolean
  onCall?: (url: string, body?: string) => void
  runStatus?: { code: string; message: string; http: number }
}) {
  return mockDomain((url, body) => {
    overrides?.onCall?.(url, body)
    if (url.includes('/agent/policy/evaluate')) {
      if (overrides?.evaluateThrows) return errEnvelope('E_INTERNAL', 'boom', 500)
      return okEnvelope(overrides?.verdict ?? { decision: 'ask', rule_id: null })
    }
    if (url.includes('/exec/run')) {
      if (overrides?.runStatus) {
        const s = overrides.runStatus
        return errEnvelope(s.code, s.message, s.http)
      }
      return okEnvelope(RUN_RESULT)
    }
    if (url.includes('/exec/file_read')) return okEnvelope(FILE_READ_RESULT)
    if (url.includes('/exec/file_write')) return okEnvelope(FILE_WRITE_RESULT)
    return okEnvelope({})
  })
}

/** Drive a write tool's HITL two-call shape: needsApproval (registers, may consult the whitelist)
 *  → optional applyEdit → execute. */
async function approveAndRun(
  guard: ApprovalGuard,
  tool: Tool,
  input: unknown,
  opts?: { toolCallId?: string; execInput?: unknown; edit?: Record<string, unknown> }
): Promise<unknown> {
  const toolCallId = opts?.toolCallId ?? 'tc-e1'
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  if (opts?.edit) guard.applyEdit(toolCallId, opts.edit)
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(opts?.execInput ?? input, { toolCallId, messages: [], abortSignal: undefined })
}

describe('buildGatewayTools — MAILAGENT_OPENNESS_EXEC_TOOLS gate', () => {
  test('flag off (default) → no exec tools; ToolSet keys byte-identical to the un-flagged set', () => {
    const base = buildGatewayTools({
      domain: execDomain(),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const flagOff = buildGatewayTools({
      domain: execDomain(),
      approvalGuard: new ApprovalGuard(),
      execToolsEnabled: false,
      contextMode: 'manual_chat'
    })
    expect(Object.keys(flagOff)).toEqual(Object.keys(base))
    for (const name of GATEWAY_EXEC_TOOL_NAMES) {
      expect(base[name]).toBeUndefined()
      expect(flagOff[name]).toBeUndefined()
    }
  })

  test('flag on but NO guard → no exec tools (the writes need the guard; all-or-nothing)', () => {
    const tools = buildGatewayTools({
      domain: execDomain(),
      execToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_EXEC_TOOL_NAMES) expect(tools[name]).toBeUndefined()
  })

  test('flag on + guard → the three exec tools are appended; every base tool still present', () => {
    const base = buildGatewayTools({
      domain: execDomain(),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const tools = buildGatewayTools({
      domain: execDomain(),
      approvalGuard: new ApprovalGuard(),
      execToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_EXEC_TOOL_NAMES) expect(tools[name]).toBeDefined()
    for (const name of Object.keys(base)) expect(tools[name]).toBeDefined()
  })

  test('non-manual mode → the exec tools are NOT registered (class exec, manual-only)', () => {
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      const tools = buildGatewayTools({
        domain: execDomain(),
        approvalGuard: new ApprovalGuard(),
        execToolsEnabled: true,
        contextMode: mode
      })
      for (const name of GATEWAY_EXEC_TOOL_NAMES) expect(tools[name]).toBeUndefined()
    }
  })
})

describe('run_command (edit-tier write, structured whitelist)', () => {
  test('no matching rule (verdict ask) → asks (the approval card is shown)', async () => {
    const tools = createExecTools(execDomain({ verdict: { decision: 'ask', rule_id: null } }), [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    const needsApproval = tools.run_command.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    const asks = await needsApproval({ argv: ['/bin/echo', 'hi'] }, { toolCallId: 'tc-r' })
    expect(asks).toBe(true)
  })

  test('auto-reversible mode does NOT skip an exec card (exec relaxes only via the whitelist)', async () => {
    const tools = createExecTools(execDomain({ verdict: { decision: 'ask', rule_id: null } }), [], new ApprovalGuard(), {
      approvalMode: 'auto-reversible',
      contextMode: 'manual_chat'
    })
    const needsApproval = tools.run_command.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ argv: ['/bin/echo', 'hi'] }, { toolCallId: 'tc-ar' })).toBe(true)
  })

  test('whitelist auto_allow → skips the card AND audits approval_status=auto_whitelist + rule id', async () => {
    let evaluateBody: unknown = null
    const guard = new ApprovalGuard()
    const collector: GatewayToolAuditCollector = []
    const tools = createExecTools(
      execDomain({
        verdict: { decision: 'auto_allow', rule_id: 42 },
        onCall: (url, body) => {
          if (url.includes('/agent/policy/evaluate')) evaluateBody = body ? JSON.parse(body) : null
        }
      }),
      collector,
      guard,
      { contextMode: 'manual_chat' }
    )
    const needsApproval = tools.run_command.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    // auto_allow → needsApproval returns false (no card)
    expect(await needsApproval({ argv: ['/bin/echo', 'hi'], cwd: '/work' }, { toolCallId: 'tc-w' })).toBe(false)
    // the evaluate wire body carries capability='exec' + the action descriptor + the trusted context mode
    expect(evaluateBody).toMatchObject({
      capability: 'exec',
      action: { argv: ['/bin/echo', 'hi'], cwd: '/work' },
      contextMode: 'manual_chat'
    })
    // execute in the same call → the audit records the whitelist skip, not a human approval
    const exec = tools.run_command.execute as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
    ) => Promise<unknown>
    await exec({ argv: ['/bin/echo', 'hi'], cwd: '/work' }, { toolCallId: 'tc-w', messages: [], abortSignal: undefined })
    expect(collector[0]?.approvalStatus).toBe('auto_whitelist')
    expect(collector[0]?.whitelistRuleId).toBe(42)
    expect(collector[0]?.confirmationTier).toBe('edit')
  })

  test('whitelist evaluate error → fail-closed to the card (asks)', async () => {
    const tools = createExecTools(execDomain({ evaluateThrows: true }), [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    const needsApproval = tools.run_command.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ argv: ['/bin/echo'] }, { toolCallId: 'tc-err' })).toBe(true)
  })

  // S2 W4 (W1b review P3-1) — a hung loopback must degrade to the card in bounded time. The mock
  // fetch never resolves but honours the abort signal; AbortSignal.timeout(2500) fires → the
  // rejected evaluate falls into the .catch(() => true) → the card. Real 2.5s wait (AbortSignal
  // .timeout uses a native timer fake timers cannot drive).
  test(
    'whitelist evaluate that never resolves → aborted at 2.5s → fail-closed to the card',
    { timeout: 10_000 },
    async () => {
      const domain = execDomain()
      domain.policyEvaluate = (_cap, _action, _mode, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('policy evaluate timed out', 'AbortError'))
          )
        })
      const tools = createExecTools(domain, [], new ApprovalGuard(), {
        contextMode: 'manual_chat'
      })
      const needsApproval = tools.run_command.needsApproval as (
        i: unknown,
        o: { toolCallId: string }
      ) => boolean | Promise<boolean>
      const started = Date.now()
      expect(await needsApproval({ argv: ['/bin/echo', 'hi'] }, { toolCallId: 'tc-hang' })).toBe(true)
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(2400) // the abort (not an instant error) drove it
      expect(elapsed).toBeLessThan(8000)
    }
  )

  test('approved run POSTs /exec/run with {argv, cwd, timeout_ms}; output shape', async () => {
    let captured: { url: string; body: unknown } | null = null
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({
        onCall: (url, body) => {
          if (url.includes('/exec/run')) captured = { url, body: body ? JSON.parse(body) : null }
        }
      }),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    const out = (await approveAndRun(guard, tools.run_command, {
      argv: ['/bin/echo', 'hi'],
      cwd: '/work',
      timeout_ms: 5000
    })) as { exit_code: number; stdout: string; cwd: string; user_edited: boolean }
    expect(captured!.url).toContain('/exec/run')
    expect(captured!.body).toMatchObject({ argv: ['/bin/echo', 'hi'], cwd: '/work', timeout_ms: 5000 })
    expect(out.exit_code).toBe(0)
    expect(out.stdout).toBe('hello\n')
    expect(out.user_edited).toBe(false)
  })

  test('editableFields: applyEdit(argv) → execute runs the edited argv (effectiveInput)', async () => {
    let ranArgv: string[] | null = null
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({
        verdict: { decision: 'ask', rule_id: null },
        onCall: (url, body) => {
          if (url.includes('/exec/run') && body) ranArgv = JSON.parse(body).argv
        }
      }),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    const out = (await approveAndRun(
      guard,
      tools.run_command,
      { argv: ['/bin/echo', 'model'], timeout_ms: 60000 },
      { toolCallId: 'tc-edit', edit: { argv: ['/bin/echo', 'user'] } }
    )) as { user_edited: boolean }
    expect(ranArgv).toEqual(['/bin/echo', 'user'])
    expect(out.user_edited).toBe(true)
  })

  test('identity pin: a raw-changed exec argv (no applyEdit) → E_APPROVAL_HASH_MISMATCH, no run', async () => {
    const posted: string[] = []
    const collector: GatewayToolAuditCollector = []
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({
        verdict: { decision: 'ask', rule_id: null },
        onCall: (url, body) => {
          if (url.includes('/exec/run') && body !== undefined) posted.push(url)
        }
      }),
      collector,
      guard,
      { contextMode: 'manual_chat' }
    )
    await expect(
      approveAndRun(guard, tools.run_command, { argv: ['/bin/echo', 'ok'] }, {
        toolCallId: 'tc-pin',
        execInput: { argv: ['/bin/rm', '-rf', '/'] }
      })
    ).rejects.toThrow(/E_APPROVAL_HASH_MISMATCH/)
    expect(posted).toHaveLength(0)
    expect(collector[0]?.approvalStatus).toBe('rejected')
  })

  test('server-side E_NO_BIN surfaces as a tool error (no silent success)', async () => {
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({ runStatus: { code: 'E_NO_BIN', message: 'command not found', http: 400 } }),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    await expect(
      approveAndRun(guard, tools.run_command, { argv: ['/no/such/bin'] })
    ).rejects.toThrow(/E_NO_BIN|not found/)
  })
})

describe('file_read / file_write (edit-tier writes)', () => {
  test('file_read approved run POSTs /exec/file_read with {path, max_bytes}', async () => {
    let captured: { url: string; body: unknown } | null = null
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({
        onCall: (url, body) => {
          if (url.includes('/exec/file_read')) captured = { url, body: body ? JSON.parse(body) : null }
        }
      }),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    const out = (await approveAndRun(guard, tools.file_read, {
      path: '/work/notes.txt',
      max_bytes: 262144
    })) as { content: string; size: number }
    expect(captured!.url).toContain('/exec/file_read')
    expect(captured!.body).toMatchObject({ path: '/work/notes.txt', max_bytes: 262144 })
    expect(out.content).toBe('file body')
  })

  test('file_read on a sensitive target → E_EXEC_FLOOR_DENIED surfaces as a tool error', async () => {
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      mockDomain((url) =>
        url.includes('/exec/file_read')
          ? errEnvelope('E_EXEC_FLOOR_DENIED', 'sensitive target refused', 403)
          : okEnvelope({ decision: 'ask', rule_id: null })
      ),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    await expect(
      approveAndRun(guard, tools.file_read, { path: '/data/.env' })
    ).rejects.toThrow(/E_EXEC_FLOOR_DENIED|refused/)
  })

  test('file_write approved run POSTs /exec/file_write with {path, content, mode}', async () => {
    let captured: { url: string; body: unknown } | null = null
    const guard = new ApprovalGuard()
    const tools = createExecTools(
      execDomain({
        onCall: (url, body) => {
          if (url.includes('/exec/file_write')) captured = { url, body: body ? JSON.parse(body) : null }
        }
      }),
      [],
      guard,
      { contextMode: 'manual_chat' }
    )
    const out = (await approveAndRun(guard, tools.file_write, {
      path: '/work/out.txt',
      content: 'data',
      mode: 'create_new'
    })) as { bytes_written: number; created: boolean }
    expect(captured!.url).toContain('/exec/file_write')
    expect(captured!.body).toMatchObject({ path: '/work/out.txt', content: 'data', mode: 'create_new' })
    expect(out.created).toBe(true)
  })

  test('file_read whitelist uses capability=file_read', async () => {
    let evaluateBody: unknown = null
    const tools = createExecTools(
      execDomain({
        verdict: { decision: 'auto_allow', rule_id: 7 },
        onCall: (url, body) => {
          if (url.includes('/agent/policy/evaluate')) evaluateBody = body ? JSON.parse(body) : null
        }
      }),
      [],
      new ApprovalGuard(),
      { contextMode: 'manual_chat' }
    )
    const needsApproval = tools.file_read.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ path: '/work/a.txt' }, { toolCallId: 'tc-fr' })).toBe(false)
    expect(evaluateBody).toMatchObject({ capability: 'file_read', action: { path: '/work/a.txt' } })
  })
})
