// S5 W3 (task 07-02-s5-custom-agent-productize) — conversational custom-agent CRUD tools: flag gate
// (byte-identical off), the whole surface is manual_chat-only (class capability_change), reads are
// silent + writes ALWAYS ask (auto-reversible included), the create/update field ALLOWLIST (grant_exec
// / policy fields structurally cannot reach the wire — schema `.strict()` + wire assembly), identity
// pin (a raw-changed input of any tier → E_APPROVAL_HASH_MISMATCH, no write), and wire fidelity.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createCustomAgentTools,
  GATEWAY_CUSTOM_AGENT_TOOL_NAMES
} from '../../../src/ai-gateway/tools/agents'
import { customAgentCreateSchema, customAgentUpdateSchema } from '../../../src/ai-gateway/tools/schemas'
import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

/** A custom-agent config (wire ReportAgentConfig shape) the create/update/get calls return. */
const CUSTOM_AGENT = {
  id: 'dms-approver',
  type: 'custom',
  enabled: true,
  title: 'DMS Approver',
  schedule: { cadence: 'daily', hours: [9] },
  window_hours: null,
  prompt: '读取 DMS 审批邮件并起草回复建议。',
  prompt_is_default: false,
  model: 'claude-sonnet-4-6',
  tools_json: null,
  kos_enrich: false,
  trigger_mode: 'rolling_24h',
  timezone: '',
  body_full_priorities: [],
  trigger: { v: 1, kind: 'email_filter', subject_pattern: 'DMS.*审批' },
  tool_policy: { v: 1, allowed_tools: ['email_search', 'email_get', 'email_body'] },
  budget: { v: 1, max_steps: 6, max_runs_per_day: 12 },
  updated_at: 1750000000000
}

/** A report agent (NOT custom) so custom_agent_list filtering can be asserted. */
const REPORT_AGENT = { ...CUSTOM_AGENT, id: 'daily-digest', type: 'report', title: '每日摘要', trigger: null, tool_policy: null, budget: null }

const RUN_ROWS = [
  { jobId: 42, agentId: 'dms-approver', state: 'completed', outcome: 'completed', approvalState: null, sessionId: 7, createdAt: 1750000500000, finishedAt: 1750000560000, error: null, tokens: { input: 1200 } },
  { jobId: 41, agentId: 'dms-approver', state: 'paused_pending', outcome: 'paused_handoff', approvalState: 'pending', sessionId: 6, createdAt: 1750000400000, finishedAt: null, error: null, tokens: null }
]

interface Call {
  method: string
  url: string
  body: unknown
}

/** A domain client with a recording fetch that routes by (method, url) so create (POST /report-agents)
 *  and list (GET /report-agents) are disambiguated (the shared mockDomain responder sees no method). */
function recordingDomain(overrides?: {
  getAgent?: unknown | 'not_found'
  listAgents?: unknown[]
  runs?: unknown[]
  createStatus?: { code: string; message: string; http: number }
}): { domain: MailAgentDomainClient; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, url, body })
    const ok = (data: unknown) =>
      new Response(JSON.stringify({ status: 'success', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    const err = (code: string, message: string, status: number) =>
      new Response(JSON.stringify({ status: 'error', error: { code, message } }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    // /agent-runs (run history)
    if (url.includes('/agent-runs')) return ok(overrides?.runs ?? RUN_ROWS)
    // /report-agents/{id}/run (run_now)
    if (/\/report-agents\/[^/]+\/run/.test(url)) return ok({ jobId: 99, agentId: 'dms-approver', wasCreated: true })
    // /report-agents/{id} (update PUT / delete DELETE)
    if (/\/report-agents\/[^/?]+$/.test(url)) {
      if (method === 'DELETE') return ok({ deleted: 'dms-approver' })
      return ok(CUSTOM_AGENT) // PUT
    }
    // /report-agents (create POST / list GET / get GET?agentId)
    if (url.includes('/report-agents')) {
      if (method === 'POST') {
        if (overrides?.createStatus) {
          const s = overrides.createStatus
          return err(s.code, s.message, s.http)
        }
        return ok(CUSTOM_AGENT)
      }
      if (url.includes('agentId=')) {
        if (overrides?.getAgent === 'not_found') return err('E_NOT_FOUND', 'no such agent', 404)
        return ok(overrides?.getAgent ?? CUSTOM_AGENT)
      }
      return ok(overrides?.listAgents ?? [CUSTOM_AGENT, REPORT_AGENT])
    }
    return ok({})
  }) as unknown as typeof fetch
  const domain = new MailAgentDomainClient({ baseUrl: 'http://127.0.0.1:8200/api', localToken: 't', fetchImpl })
  return { domain, calls }
}

/** Drive a write tool's HITL two-call shape (register → execute). */
async function approveAndRun(
  tool: Tool,
  input: unknown,
  opts?: { toolCallId?: string; execInput?: unknown }
): Promise<unknown> {
  const toolCallId = opts?.toolCallId ?? 'tc-a1'
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(opts?.execInput ?? input, { toolCallId, messages: [], abortSignal: undefined })
}

async function runRead(tool: Tool, input: unknown): Promise<unknown> {
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(input, { toolCallId: 'tc-r1', messages: [], abortSignal: undefined })
}

describe('buildGatewayTools — MAILAGENT_CUSTOM_AGENTS_ENABLED gate', () => {
  test('flag off (default) → no custom-agent tools; ToolSet keys byte-identical to the un-flagged set', () => {
    const base = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const flagOff = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      customAgentToolsEnabled: false,
      contextMode: 'manual_chat'
    })
    expect(Object.keys(flagOff)).toEqual(Object.keys(base))
    for (const name of GATEWAY_CUSTOM_AGENT_TOOL_NAMES) {
      expect(base[name]).toBeUndefined()
      expect(flagOff[name]).toBeUndefined()
    }
  })

  test('flag on but NO guard → none of the six (all-or-nothing: half a capability never registers)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      customAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_CUSTOM_AGENT_TOOL_NAMES) expect(tools[name]).toBeUndefined()
  })

  test('flag on + guard → the six tools are appended; every base tool still present', () => {
    const base = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      customAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_CUSTOM_AGENT_TOOL_NAMES) expect(tools[name]).toBeDefined()
    for (const name of Object.keys(base)) expect(tools[name]).toBeDefined()
  })

  test('non-manual mode → the ENTIRE custom-agent surface is dropped (class capability_change)', () => {
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        approvalGuard: new ApprovalGuard(),
        customAgentToolsEnabled: true,
        contextMode: mode
      })
      for (const name of GATEWAY_CUSTOM_AGENT_TOOL_NAMES) {
        expect(tools[name], `${name} must not register in ${mode}`).toBeUndefined()
      }
    }
  })
})

describe('custom_agent_list / custom_agent_get (silent reads)', () => {
  test('list is a silent read (no needsApproval), filters to type=custom', async () => {
    const { domain } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    expect(tools.custom_agent_list.needsApproval).toBeUndefined()
    const out = (await runRead(tools.custom_agent_list, {})) as {
      count: number
      items: Array<{ id: string; trigger_summary: string }>
    }
    expect(out.count).toBe(1) // the report agent is filtered out
    expect(out.items[0].id).toBe('dms-approver')
    expect(out.items[0].trigger_summary).toContain('email_filter')
  })

  test('get returns the full spec + recent runs (state passed through verbatim, not re-derived)', async () => {
    const { domain } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    expect(tools.custom_agent_get.needsApproval).toBeUndefined()
    const out = (await runRead(tools.custom_agent_get, { agent_id: 'dms-approver', runs_limit: 5 })) as {
      found: boolean
      allowed_tools: string[]
      recent_runs: Array<{ state: string; outcome: string | null }>
    }
    expect(out.found).toBe(true)
    expect(out.allowed_tools).toEqual(['email_search', 'email_get', 'email_body'])
    expect(out.recent_runs.map((r) => r.state)).toEqual(['completed', 'paused_pending'])
    // a paused run keeps its authoritative state — never renamed to a success
    expect(out.recent_runs[1].state).toBe('paused_pending')
    expect(out.recent_runs[1].outcome).toBe('paused_handoff')
  })

  test('get returns found:false for a non-custom / missing id', async () => {
    const { domain } = recordingDomain({ getAgent: { ...REPORT_AGENT } })
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    const out = (await runRead(tools.custom_agent_get, { agent_id: 'daily-digest', runs_limit: 5 })) as {
      found: boolean
    }
    expect(out.found).toBe(false)
  })
})

describe('custom_agent_create / update (edit-tier capability_change writes)', () => {
  test('always asks — even in auto-reversible mode (capability_change never auto-approves)', async () => {
    const { domain } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), {
      approvalMode: 'auto-reversible',
      contextMode: 'manual_chat'
    })
    const needsApproval = tools.custom_agent_create.needsApproval as (
      i: unknown,
      o: { toolCallId: string }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ id: 'x', title: 't' }, { toolCallId: 'tc-c' })).toBe(true)
  })

  test('approved create POSTs /report-agents with type=custom + mapped friendly patch', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    const out = (await approveAndRun(tools.custom_agent_create, {
      id: 'dms-approver',
      title: 'DMS Approver',
      prompt: '读取 DMS 审批邮件。',
      enabled: true,
      trigger: { kind: 'email_filter', subject_pattern: 'DMS.*审批' },
      allowed_tools: ['email_search', 'email_get'],
      budget: { max_steps: 6 }
    })) as { created: boolean; id: string }
    const post = calls.find((c) => c.method === 'POST' && /\/report-agents$/.test(c.url))!
    expect(post).toBeDefined()
    expect(post.body).toEqual({
      id: 'dms-approver',
      type: 'custom',
      title: 'DMS Approver',
      prompt: '读取 DMS 审批邮件。',
      enabled: true,
      // trigger + budget gain the v:1 bit; allowed_tools becomes tool_policy {v:1, allowed_tools}
      trigger: { kind: 'email_filter', subject_pattern: 'DMS.*审批', v: 1 },
      tool_policy: { v: 1, allowed_tools: ['email_search', 'email_get'] },
      budget: { max_steps: 6, v: 1 }
    })
    expect(out.created).toBe(true)
    expect(out.id).toBe('dms-approver')
  })

  test('a cron trigger maps to a 5-field cron wire trigger', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    await approveAndRun(tools.custom_agent_create, {
      id: 'daily-sweep',
      title: 'Daily Sweep',
      trigger: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' }
    })
    const post = calls.find((c) => c.method === 'POST' && /\/report-agents$/.test(c.url))!
    expect((post.body as { trigger: unknown }).trigger).toEqual({
      kind: 'cron',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      v: 1
    })
  })

  test('update PUTs the partial patch to /report-agents/{id}; empty patch is rejected before any wire call', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    await approveAndRun(tools.custom_agent_update, { agent_id: 'dms-approver', enabled: false })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toContain('/report-agents/dms-approver')
    expect(put.body).toEqual({ enabled: false })

    const { domain: d2, calls: c2 } = recordingDomain()
    const t2 = createCustomAgentTools(d2, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    await expect(
      approveAndRun(t2.custom_agent_update, { agent_id: 'dms-approver' }, { toolCallId: 'tc-empty' })
    ).rejects.toThrow(/E_INVALID_ARG|at least one field/)
    expect(c2.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  test('update trigger:null disables the agent (clears the trigger on the wire)', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    await approveAndRun(tools.custom_agent_update, { agent_id: 'dms-approver', trigger: null })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({ trigger: null })
  })

  test('identity pin: a raw-changed create input (no applyEdit) → E_APPROVAL_HASH_MISMATCH, no POST', async () => {
    const collector: GatewayToolAuditCollector = []
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, collector, new ApprovalGuard(), { contextMode: 'manual_chat' })
    await expect(
      approveAndRun(
        tools.custom_agent_create,
        { id: 'good', title: 'Good' },
        { toolCallId: 'tc-pin', execInput: { id: 'evil', title: 'Evil' } }
      )
    ).rejects.toThrow(/E_APPROVAL_HASH_MISMATCH/)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(collector[0]?.approvalStatus).toBe('rejected')
  })
})

describe('custom_agent_delete / run_now (edit-tier writes)', () => {
  test('delete DELETEs /report-agents/{id}', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    const out = (await approveAndRun(tools.custom_agent_delete, { agent_id: 'dms-approver' })) as {
      deleted: string
    }
    const del = calls.find((c) => c.method === 'DELETE')!
    expect(del.url).toContain('/report-agents/dms-approver')
    expect(out.deleted).toBe('dms-approver')
  })

  test('run_now POSTs /report-agents/{id}/run and returns the job id', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    const out = (await approveAndRun(tools.custom_agent_run_now, { agent_id: 'dms-approver' })) as {
      enqueued: boolean
      job_id: number
    }
    const run = calls.find((c) => /\/report-agents\/dms-approver\/run$/.test(c.url))!
    expect(run.method).toBe('POST')
    expect(out.enqueued).toBe(true)
    expect(out.job_id).toBe(99)
  })
})

describe('field ALLOWLIST — grant_exec / policy fields structurally cannot enter (ADR-004 D5)', () => {
  test('the create/update schemas are strict: a grant_exec key is rejected at parse', () => {
    const withGrant = { id: 'x', title: 't', grant_exec: true }
    expect(customAgentCreateSchema.safeParse(withGrant).success).toBe(false)
    const withToolPolicy = { agent_id: 'x', tool_policy: { v: 1, grant_exec: true } }
    expect(customAgentUpdateSchema.safeParse(withToolPolicy).success).toBe(false)
    // the sanctioned fields still parse
    expect(
      customAgentCreateSchema.safeParse({ id: 'x', title: 't', allowed_tools: ['email_get'] }).success
    ).toBe(true)
  })

  test('even a schema-bypassed input never carries grant_exec / policy fields onto the wire', async () => {
    const { domain, calls } = recordingDomain()
    const tools = createCustomAgentTools(domain, [], new ApprovalGuard(), { contextMode: 'manual_chat' })
    // execute receives already-parsed input, so inject a hostile object directly — the wire body is
    // assembled field-by-field from the ALLOWLIST, so grant_exec / policy_rules can never reach REST.
    const hostile = {
      id: 'sneaky',
      title: 'Sneaky',
      allowed_tools: ['run_command'],
      grant_exec: true,
      tool_policy: { v: 1, grant_exec: true },
      policy_rules: [{ capability: 'exec' }]
    }
    await approveAndRun(tools.custom_agent_create, hostile, { execInput: hostile })
    const post = calls.find((c) => c.method === 'POST' && /\/report-agents$/.test(c.url))!
    const body = post.body as Record<string, unknown>
    expect(body.grant_exec).toBeUndefined()
    expect(body.policy_rules).toBeUndefined()
    // tool_policy IS present but only ever carries {v, allowed_tools} — never grant_exec
    expect(body.tool_policy).toEqual({ v: 1, allowed_tools: ['run_command'] })
    expect((body.tool_policy as Record<string, unknown>).grant_exec).toBeUndefined()
  })
})
