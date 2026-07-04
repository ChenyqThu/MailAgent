// S5 W4 (ADR-004 D1/§3.1) — per-agent domain_write免卡: the write factory injects policyEvaluate
// ONLY for a headless agent run (contextMode ∈ {untrusted_trigger, cron_headless} + agentId).
//
// Pinned invariants:
//   - manual runs (with or without a stray agentRunContext) NEVER consult the whitelist — the
//     evaluate endpoint is not touched and the approvalMode branches behave byte-identically
//     (rev0's shadowing risk: an unconditional policyEvaluate would replace the auto-reversible
//     local predicate with a loopback RTT + rule requirement);
//   - headless + rule hit (auto_allow) → NO card, execute in the same call, audit
//     approval_status='auto_whitelist' + whitelist_rule_id — and NO island stash/announce (免卡不进岛:
//     a needsApproval=false call never pauses, so makePersistOnFinish's stash path is unreachable);
//   - headless + ask / evaluate error → the card (fail-closed, ADR-003 D4 semantics);
//   - the evaluate wire body: capability='domain_write', action={tool} (matcher V1 pins the tool
//     name only), the DERIVED contextMode and the agentId.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope, errEnvelope } from './_helpers'

const FLAG_INPUT = { internal_id: 5, is_flagged: true }

/** Mock domain covering /email/flag + /agent/policy/evaluate with call capture. */
function writeDomain(overrides?: {
  verdict?: { decision: 'auto_allow' | 'ask'; rule_id: number | null }
  evaluateThrows?: boolean
  onCall?: (url: string, body?: string) => void
}) {
  return mockDomain((url, body) => {
    overrides?.onCall?.(url, body)
    if (url.includes('/agent/policy/evaluate')) {
      if (overrides?.evaluateThrows) return errEnvelope('E_INTERNAL', 'boom', 500)
      return okEnvelope(overrides?.verdict ?? { decision: 'ask', rule_id: null })
    }
    return okEnvelope({ updated_ids: [5], outbox_entries: [] })
  })
}

function needsApprovalOf(tool: Tool) {
  return tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
}

function executeOf(tool: Tool) {
  return tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
}

describe('manual runs — policyEvaluate is NEVER injected (byte-identical branches)', () => {
  test('manual + auto-reversible: preview write skips the card via the LOCAL predicate; evaluate endpoint untouched', async () => {
    const evaluateCalls: string[] = []
    const tools = createWriteTools(
      writeDomain({ onCall: (url) => url.includes('/agent/policy/evaluate') && evaluateCalls.push(url) }),
      [],
      new ApprovalGuard(),
      { approvalMode: 'auto-reversible', contextMode: 'manual_chat' }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-m1', messages: [] })).toBe(false)
    expect(evaluateCalls).toHaveLength(0)
  })

  test('manual + always: preview write asks; evaluate endpoint untouched', async () => {
    const evaluateCalls: string[] = []
    const tools = createWriteTools(
      writeDomain({ onCall: (url) => url.includes('/agent/policy/evaluate') && evaluateCalls.push(url) }),
      [],
      new ApprovalGuard(),
      { contextMode: 'manual_chat' }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-m2', messages: [] })).toBe(true)
    expect(evaluateCalls).toHaveLength(0)
  })

  test('manual + a STRAY agentRunContext still never injects (the headless predicate requires the mode too)', async () => {
    const evaluateCalls: string[] = []
    const tools = createWriteTools(
      writeDomain({ onCall: (url) => url.includes('/agent/policy/evaluate') && evaluateCalls.push(url) }),
      [],
      new ApprovalGuard(),
      {
        contextMode: 'manual_chat',
        agentRunContext: { agentId: 'dms', allowedTools: ['email_flag'] }
      }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-m3', messages: [] })).toBe(true)
    expect(evaluateCalls).toHaveLength(0)
  })

  test('headless WITHOUT an agentId (S4 shape) never injects either — zero免卡 channels without a per-agent context', async () => {
    const evaluateCalls: string[] = []
    const tools = createWriteTools(
      writeDomain({ onCall: (url) => url.includes('/agent/policy/evaluate') && evaluateCalls.push(url) }),
      [],
      new ApprovalGuard(),
      { contextMode: 'untrusted_trigger' }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-m4', messages: [] })).toBe(true)
    expect(evaluateCalls).toHaveLength(0)
  })

  test('empty-string agentId fail-closes to no injection', async () => {
    const evaluateCalls: string[] = []
    const tools = createWriteTools(
      writeDomain({ onCall: (url) => url.includes('/agent/policy/evaluate') && evaluateCalls.push(url) }),
      [],
      new ApprovalGuard(),
      { contextMode: 'cron_headless', agentRunContext: { agentId: '', allowedTools: [] } }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-m5', messages: [] })).toBe(true)
    expect(evaluateCalls).toHaveLength(0)
  })
})

describe('headless agent runs — per-agent domain_write whitelist', () => {
  const CTX = { agentId: 'dms', allowedTools: ['email_flag', 'email_draft_reply'] }

  test('rule hit: evaluate wire = {domain_write, {tool}, derived mode, agentId}; no card; audit auto_whitelist + rule id', async () => {
    let evaluateBody: unknown = null
    const guard = new ApprovalGuard()
    const collector: GatewayToolAuditCollector = []
    const tools = createWriteTools(
      writeDomain({
        verdict: { decision: 'auto_allow', rule_id: 17 },
        onCall: (url, body) => {
          if (url.includes('/agent/policy/evaluate')) evaluateBody = body ? JSON.parse(body) : null
        }
      }),
      collector,
      guard,
      { contextMode: 'untrusted_trigger', agentRunContext: CTX }
    )
    // auto_allow → no card (needsApproval false) …
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-h1', messages: [] })).toBe(false)
    // … the wire carries the V1 matcher descriptor (tool name pin) + the derived mode + agentId
    expect(evaluateBody).toMatchObject({
      capability: 'domain_write',
      action: { tool: 'email_flag' },
      contextMode: 'untrusted_trigger',
      agentId: 'dms'
    })
    // … execute runs in the SAME call and audits the whitelist skip (distinct from a human approval)
    await executeOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-h1', messages: [], abortSignal: undefined })
    expect(collector[0]?.approvalStatus).toBe('auto_whitelist')
    expect(collector[0]?.whitelistRuleId).toBe(17)
    expect(collector[0]?.confirmationTier).toBe('preview')
  })

  test('免卡不进岛: an auto_allow write never pauses → nothing for the island to stash/announce', async () => {
    // needsApproval=false means ai@7 executes in the SAME call — the turn carries no
    // approval-requested part, so makePersistOnFinish's stash path (which requires
    // responseMessageAwaitsApproval) is structurally unreachable. Assert the observable half:
    // no card + immediate execute (the agent_run.test paused_handoff cases pin the stash side).
    const guard = new ApprovalGuard()
    const collector: GatewayToolAuditCollector = []
    const tools = createWriteTools(
      writeDomain({ verdict: { decision: 'auto_allow', rule_id: 3 } }),
      collector,
      guard,
      { contextMode: 'cron_headless', agentRunContext: CTX }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-h2', messages: [] })).toBe(false)
    const out = (await executeOf(tools.email_flag)(FLAG_INPUT, {
      toolCallId: 'tc-h2',
      messages: [],
      abortSignal: undefined
    })) as { internal_id: number }
    expect(out.internal_id).toBe(5)
    expect(collector[0]?.approvalStatus).toBe('auto_whitelist')
  })

  test('no rule (ask) → the card (needsApproval true) — headless writes stay HITL without a rule', async () => {
    const tools = createWriteTools(
      writeDomain({ verdict: { decision: 'ask', rule_id: null } }),
      [],
      new ApprovalGuard(),
      { contextMode: 'untrusted_trigger', agentRunContext: CTX }
    )
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-h3', messages: [] })).toBe(true)
  })

  test('evaluate error → fail-closed to the card, never a silent免卡', async () => {
    const tools = createWriteTools(writeDomain({ evaluateThrows: true }), [], new ApprovalGuard(), {
      contextMode: 'cron_headless',
      agentRunContext: CTX
    })
    expect(await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-h4', messages: [] })).toBe(true)
  })

  test('every domain_write tool sends its OWN name as the descriptor (per-tool rules, not per-class)', async () => {
    const descriptors: string[] = []
    const tools = createWriteTools(
      writeDomain({
        verdict: { decision: 'ask', rule_id: null },
        onCall: (url, body) => {
          if (url.includes('/agent/policy/evaluate') && body) {
            descriptors.push((JSON.parse(body) as { action: { tool: string } }).action.tool)
          }
        }
      }),
      [],
      new ApprovalGuard(),
      { contextMode: 'untrusted_trigger', agentRunContext: CTX }
    )
    await needsApprovalOf(tools.email_flag)(FLAG_INPUT, { toolCallId: 'tc-d1', messages: [] })
    await needsApprovalOf(tools.email_archive)({ internal_id: 5 }, { toolCallId: 'tc-d2', messages: [] })
    await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 5, body_markdown: 'x' },
      { toolCallId: 'tc-d3', messages: [] }
    )
    expect(descriptors).toEqual(['email_flag', 'email_archive', 'email_draft_reply'])
  })
})
