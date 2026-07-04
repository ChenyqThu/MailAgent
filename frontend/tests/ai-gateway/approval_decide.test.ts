// Part B (harness 上岛) — POST /api/ai/approval/decide (server-side island approval resume).
//
// Drives the real gateway (startAiGatewayServer) with a MockLanguageModelV3 + a real write tool
// bound to a spy domain + a shared ApprovalGuard + ApprovalRunStash. Simulates the FIRST (paused)
// call by registering the guard record + stashing the run, then POSTs /decide and asserts the tool
// resumed server-side (no renderer). Also covers: flag-off 404, bad token 404, bad args 400, reject,
// and the single-resolver short-circuit (renderer already consumed).

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, IslandApprovalAnnounce } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import { mayAutoApprove, type AgentRunContext } from '../../src/ai-gateway/tools/policy'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** A model that just streams closing text (called AFTER the approved tool executes on resume). */
function mockTextModel(parts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 }
            }
          }
        ]
      })
    })
  })
}

const DRAFT_INPUT = { internal_id: 5, body_markdown: 'draft body' }
const TC = 'tc_draft'
const AP = 'ap_draft'

/** The paused assistant message: the write tool is awaiting approval (state approval-requested). */
function pausedResponse(): MailAgentUIMessage {
  return {
    id: 'a-paused',
    role: 'assistant',
    parts: [
      {
        type: 'tool-email_draft_reply',
        toolCallId: TC,
        state: 'approval-requested',
        input: DRAFT_INPUT,
        approval: { id: AP }
      }
    ]
  } as unknown as MailAgentUIMessage
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我起草回复' }] }

/** A spy domain — only draftReply is exercised on the resume; others are never called. */
function spyDomain(calls: unknown[]): MailAgentDomainClient {
  return {
    draftReply: async (internalId: number, body: string) => {
      calls.push({ internalId, body })
      return { internalId, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
    }
  } as unknown as MailAgentDomainClient
}

/** Build a gateway cfg with island agent on: real guard + stash + write tool + mock model. */
function islandCfg(opts: {
  guard: ApprovalGuard
  stash: ApprovalRunStash
  domainCalls: unknown[]
  resolved?: (tc: string) => boolean
  onServerResumeSettled?: AiGatewayConfig['onServerResumeSettled']
}): AiGatewayConfig {
  const { guard, stash, domainCalls } = opts
  const domain = spyDomain(domainCalls)
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => mockTextModel(['草稿已创建。']),
    // S2 W0 — thread the trusted contextMode like the production lifecycle does (the resume
    // passes the stash-frozen mode via prepareChatRun → buildTools's 3rd param).
    buildTools: (collector, _approvalMode, contextMode) =>
      buildGatewayTools(
        { domain, writeToolsEnabled: true, approvalGuard: guard, oneShotWrites: true, contextMode },
        collector
      ),
    islandAgentEnabled: true,
    approvalStash: stash,
    isApprovalResolved: opts.resolved,
    // the real guard is the tombstone target for an island reject (finding 1)
    rejectApproval: (tc: string) => guard.reject(tc),
    onServerResumeSettled: opts.onServerResumeSettled
  }
}

function decide(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/approval/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** Simulate the first (paused) call: register the approval + stash the run. Returns the resumeToken. */
function seedPausedApproval(guard: ApprovalGuard, stash: ApprovalRunStash): string {
  guard.register(TC, 'email_draft_reply', 'edit', DRAFT_INPUT, ['body_markdown'])
  return stash.stash({
    toolCallId: TC,
    approvalId: AP,
    toolName: 'email_draft_reply',
    sessionId: 1,
    body: { messages: [USER], model: 'claude-sonnet-4-6', sessionId: 1 },
    responseMessage: pausedResponse(),
    // S2 W0 — the pause happened in a manual session; the resume must re-run under it.
    contextMode: 'manual_chat'
  })
}

describe('/api/ai/approval/decide — gating + validation', () => {
  test('island agent OFF (no stash) → 404 not implemented', async () => {
    const h = await start({
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['x'])
    })
    const res = await decide(h.port, { toolCallId: 'x', decision: 'approve', resumeToken: 't' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
  })

  test('missing toolCallId / resumeToken → 400', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const h = await start(islandCfg({ guard, stash, domainCalls: [] }))
    const res = await decide(h.port, { decision: 'approve' })
    expect(res.status).toBe(400)
  })

  test('unknown toolCallId / wrong token → 404 not_found (fail-closed)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const h = await start(islandCfg({ guard, stash, domainCalls: [] }))
    const res = await decide(h.port, {
      toolCallId: 'nope',
      decision: 'approve',
      resumeToken: 'bad'
    })
    expect(res.status).toBe(404)
    expect((await res.json()).status).toBe('not_found')
  })
})

// S6 W2 (PRD P8 + P9) — the IN-RECORD decide path. P8: the stash PRESENCE (not cfg.islandAgentEnabled)
// gates /decide, so a headless custom-agent pause is claimable in-app with the island OFF. P9: the
// record view drives it with the { approvalId, decision } shape (NO resumeToken — the gateway resolves
// the internal token from the stash so the capability never leaves it). Modeled on the real
// custom-agents-only lifecycle: island flag OFF, no isApprovalResolved / rejectApproval / oneShotWrites
// (those are island↔renderer race machinery, unreachable when only /decide can resume an agent run).
describe('/api/ai/approval/decide — in-record { approvalId } shape (P8 + P9)', () => {
  /** A custom-agents-only cfg: stash wired, island flag OFF, no island-race hooks (mirrors the
   *  lifecycle when only MAILAGENT_CUSTOM_AGENTS_ENABLED is on). */
  function customAgentCfg(
    guard: ApprovalGuard,
    stash: ApprovalRunStash,
    domainCalls: unknown[]
  ): AiGatewayConfig {
    const domain = spyDomain(domainCalls)
    return {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['草稿已创建。']),
      buildTools: (collector, _approvalMode, contextMode) =>
        buildGatewayTools(
          { domain, writeToolsEnabled: true, approvalGuard: guard, contextMode },
          collector
        ),
      // islandAgentEnabled OMITTED — the stash presence alone must enable /decide (P8).
      approvalStash: stash
    }
  }

  test('{ approvalId, approve } with the island flag OFF → tool executes server-side (P8 + P9)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(customAgentCfg(guard, stash, domainCalls))
    seedPausedApproval(guard, stash) // the token is discarded — the record view never sees it

    // NO resumeToken in the body — the gateway resolves it internally from the approvalId (AP).
    const res = await decide(h.port, { approvalId: AP, decision: 'approve' })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(1)
    // one-shot at the stash level: a second in-record decide → 404 not_found (already claimed)
    const res2 = await decide(h.port, { approvalId: AP, decision: 'approve' })
    expect(res2.status).toBe(404)
    expect((await res2.json()).status).toBe('not_found')
  })

  test('{ approvalId, reject } → tool does NOT execute; status rejected', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(customAgentCfg(guard, stash, domainCalls))
    seedPausedApproval(guard, stash)
    const res = await decide(h.port, { approvalId: AP, decision: 'reject' })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('rejected')
    expect(domainCalls).toHaveLength(0)
  })

  test('wrong / stale approvalId → 404 not_found (fail-closed), nothing runs', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(customAgentCfg(guard, stash, domainCalls))
    seedPausedApproval(guard, stash)
    const res = await decide(h.port, { approvalId: 'ap_nope', decision: 'approve' })
    expect(res.status).toBe(404)
    expect((await res.json()).status).toBe('not_found')
    expect(domainCalls).toHaveLength(0)
  })

  test('the resumeToken is NEVER required NOR echoed for the in-record shape', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(customAgentCfg(guard, stash, domainCalls))
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { approvalId: AP, decision: 'approve' })
    const raw = await res.text()
    expect(raw).not.toContain(token) // the capability token never leaves the gateway
  })

  test('both server-resume flags off (no stash) → /decide 404 (byte-identical to pre-S6)', async () => {
    const h = await start({
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['x'])
    })
    const res = await decide(h.port, { approvalId: AP, decision: 'approve' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
  })

  test('the island { toolCallId, resumeToken } shape still works on the same stash (both coexist)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(customAgentCfg(guard, stash, domainCalls))
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(1)
  })
})

describe('/api/ai/approval/decide — server-side resume', () => {
  test('approve → the write tool executes server-side; status completed', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(islandCfg({ guard, stash, domainCalls }))
    const token = seedPausedApproval(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('completed')
    // the real write ran server-side (no renderer)
    expect(domainCalls).toHaveLength(1)
    expect((domainCalls[0] as { internalId: number }).internalId).toBe(5)
    // one-shot: a second decide with the same (now-consumed) token → not_found
    const res2 = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res2.status).toBe(404)
  })

  test('reject → tool does NOT execute; status rejected', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(islandCfg({ guard, stash, domainCalls }))
    const token = seedPausedApproval(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'reject', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('rejected')
    expect(domainCalls).toHaveLength(0) // rejected → no write
  })

  // finding 1 — an island reject is TERMINAL: it tombstones the guard so a later approve on the OTHER
  // surface (renderer) fails closed. Prove the guard is now resolved + verify() rejects.
  test('reject tombstones the guard → a later approve fails closed (E_APPROVAL_USED)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const h = await start(islandCfg({ guard, stash, domainCalls }))
    const token = seedPausedApproval(guard, stash)

    await decide(h.port, { toolCallId: TC, decision: 'reject', resumeToken: token })
    // the guard now reports a terminal decision, and any subsequent execute (renderer approve) throws.
    expect(guard.isResolved(TC)).toBe(true)
    expect(() => guard.verify(TC, DRAFT_INPUT)).toThrowError(/E_APPROVAL_USED/)
    expect(domainCalls).toHaveLength(0)
  })

  test('single-resolver: renderer already resolved → short-circuit completed, no re-execute', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    // isApprovalResolved returns true → the renderer won the race (approve OR reject); /decide must NOT
    // re-run — no double execute, no double persist.
    const h = await start(islandCfg({ guard, stash, domainCalls, resolved: () => true }))
    const token = seedPausedApproval(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(0) // did not re-execute (already done in-app)
  })
})

// S2 W0/W1 (ADR-001 D1) — resume-path contextMode FREEZE. A run paused under a non-manual mode must
// resume under EXACTLY that mode: the stash carries the frozen contextMode, resumeApprovalRun passes
// it back through prepareChatRun → buildTools (3rd param), NEVER the request body. Negative proof:
// stash 'untrusted_trigger' → the resume's buildTools receives 'untrusted_trigger' → every
// capability_change/exec/outbound tool is stripped + domain_write cannot auto-approve.
describe('/api/ai/approval/decide — contextMode freeze (untrusted_trigger resume)', () => {
  test('resume rebuilds tools under the STASH-frozen untrusted_trigger mode (no manual escalation)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const domain = spyDomain(domainCalls)
    // Capture the contextMode + the resulting ToolSet keys each buildTools call sees (the resume is
    // the only call here). Build the FULL flag-on set so capability_change/exec/outbound tools WOULD
    // exist in manual_chat — proving they are dropped comes from the frozen mode, not from flags-off.
    const seen: { mode: string | undefined; keys: string[] }[] = []
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['done.']),
      buildTools: (collector, _approvalMode, contextMode) => {
        const tools = buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            approvalGuard: guard,
            sendToolEnabled: true,
            sendSigningSecret: 'secret',
            skillGatingEnabled: true,
            webToolsEnabled: true,
            execToolsEnabled: true,
            oneShotWrites: true,
            contextMode
          },
          collector
        )
        seen.push({ mode: contextMode, keys: Object.keys(tools) })
        return tools
      },
      islandAgentEnabled: true,
      approvalStash: stash,
      rejectApproval: (tc: string) => guard.reject(tc)
    }
    const h = await start(cfg)
    // Seed a paused approval FROZEN at untrusted_trigger (the email_draft_reply is domain_write, so
    // the resume still executes it — the point is the OTHER classes are gone + the mode is frozen).
    guard.register(TC, 'email_draft_reply', 'edit', DRAFT_INPUT, ['body_markdown'])
    const token = stash.stash({
      toolCallId: TC,
      approvalId: AP,
      toolName: 'email_draft_reply',
      sessionId: 1,
      body: { messages: [USER], model: 'claude-sonnet-4-6', sessionId: 1 },
      responseMessage: pausedResponse(),
      contextMode: 'untrusted_trigger'
    })

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')

    // buildTools was called during the resume under the FROZEN mode (never manual_chat).
    expect(seen.length).toBeGreaterThan(0)
    const resumeBuild = seen[seen.length - 1]
    expect(resumeBuild.mode).toBe('untrusted_trigger')
    // capability_change / exec / outbound tools are absent from the resumed ToolSet.
    for (const name of [
      'set_skill_enabled',
      'update_system_md',
      'run_command',
      'file_write',
      'web_fetch',
      'email_prepare_send'
    ]) {
      expect(resumeBuild.keys, `${name} must be stripped under untrusted_trigger`).not.toContain(name)
    }
    // domain_write survives (allowed in every mode) but cannot auto-approve outside manual_chat.
    expect(resumeBuild.keys).toContain('email_flag')
    expect(mayAutoApprove('domain_write', 'untrusted_trigger')).toBe(false)
  })
})

// Part B (dogfood live-refresh) — /decide notifies cfg.onServerResumeSettled on a TERMINAL settle
// (completed / rejected / error) so the lifecycle can broadcast 'chat:session-updated' to an open
// panel. NOT on repaused (asserted in the chained-hop test below) nor not_found; unwired hook → the
// resume still settles (no crash).
describe('/api/ai/approval/decide — onServerResumeSettled (panel live-refresh)', () => {
  test('approve → completed → hook fires with (sessionId, completed)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect(settled).toEqual([{ sessionId: 1, status: 'completed' }])
  })

  test('reject → rejected → hook fires with (sessionId, rejected)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { toolCallId: TC, decision: 'reject', resumeToken: token })
    expect(res.status).toBe(200)
    expect(settled).toEqual([{ sessionId: 1, status: 'rejected' }])
  })

  test('error (no approval part in the stashed message) → hook fires with (sessionId, error)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    guard.register(TC, 'email_draft_reply', 'edit', DRAFT_INPUT, ['body_markdown'])
    // a stashed responseMessage WITHOUT the approval-requested part → applyApprovalResponseToMessages
    // applied=false → status 'error' (with the entry's sessionId).
    const token = stash.stash({
      toolCallId: TC,
      approvalId: AP,
      toolName: 'email_draft_reply',
      sessionId: 7,
      body: { messages: [USER], model: 'claude-sonnet-4-6', sessionId: 7 },
      responseMessage: {
        id: 'a-broken',
        role: 'assistant',
        parts: [{ type: 'text', text: 'x' }]
      } as unknown as MailAgentUIMessage
    })
    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('error')
    expect(settled).toEqual([{ sessionId: 7, status: 'error' }])
  })

  test('not_found → hook NOT called', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    const res = await decide(h.port, {
      toolCallId: 'nope',
      decision: 'approve',
      resumeToken: 'bad'
    })
    expect(res.status).toBe(404)
    expect(settled).toEqual([])
  })

  test('hook unwired → the resume still settles (no crash)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    // islandCfg without onServerResumeSettled → cfg hook undefined → server.ts ?. short-circuits.
    const h = await start(islandCfg({ guard, stash, domainCalls }))
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(1)
  })
})

// S6 W1 (PRD P3) — the /decide settle chain is ISLAND-AGNOSTIC. The endpoint takes ONLY
// { toolCallId, decision, resumeToken } — it has NO caller-identity input, so it cannot branch on
// "island ack" vs "in-app record-view". Whoever posts a valid token drives the SAME
// onServerResumeSettled(sessionId, status) the lifecycle wires once (which broadcasts
// chat:session-updated + writes the agent approval-state back). This pins that an in-app decision
// (record view) reuses the island's resume + settle path — no second approval surface, no caller
// branch. It asserts the CHAIN, not its identity: the endpoint behaviour is unchanged (W1 adds only
// this regression pin, matching the existing onServerResumeSettled coverage above).
describe('/api/ai/approval/decide — island-agnostic settle chain (in-app decide)', () => {
  test('an in-app decide (same body an island ack sends) fires the settle hook identically', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    const token = seedPausedApproval(guard, stash)

    // The record-view client posts EXACTLY { toolCallId, decision, resumeToken } — byte-identical to
    // the body serve-api's island ack posts. No field could tell the endpoint "who" called.
    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    // The lifecycle-wired settle hook fired with the terminal (sessionId, status) — the SAME chain
    // that broadcasts chat:session-updated + settles agent approval-state, regardless of caller.
    expect(settled).toEqual([{ sessionId: 1, status: 'completed' }])
  })

  test('an in-app reject settles rejected identically (no caller branch on the settle chain)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const settled: Array<{ sessionId: number; status: string }> = []
    const h = await start(
      islandCfg({
        guard,
        stash,
        domainCalls: [],
        onServerResumeSettled: (sessionId, status) => settled.push({ sessionId, status })
      })
    )
    const token = seedPausedApproval(guard, stash)
    const res = await decide(h.port, { toolCallId: TC, decision: 'reject', resumeToken: token })
    expect(res.status).toBe(200)
    expect(settled).toEqual([{ sessionId: 1, status: 'rejected' }])
  })
})

// HIGH-1 (rebase 复审, architect + codex 第 3 轮同根因) — chained two-hop island approvals.
// hop-1 /decide(A approve) re-pauses on approval B: the re-stash's body = run.originalBody, whose
// messages ALREADY end with the hop-1 merged assistant (same UIMessage id as the re-stashed
// responseMessage). Without the id-dedup in resumeApprovalRun's history reconstruction, hop-2 would
// send TWO copies of that assistant (both carrying tool-call A) to the model → duplicate tool_use ids
// upstream → 400 → the second hop never executes. The flagship "draft then send" chain breaks.
describe('/api/ai/approval/decide — chained two-hop approvals (repause)', () => {
  const TC_B = 'tc_draft_b'
  const DRAFT_INPUT_B = { internal_id: 6, body_markdown: 'second draft' }
  const USAGE = {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 }
  }

  /** Collect the toolCallIds of every assistant `tool-call` content part in a captured model prompt
   *  (LanguageModelV3Prompt). This is the direct observable of the HIGH-1 bug: a duplicated history
   *  assistant emits the SAME toolCallId twice. */
  function promptToolCallIds(prompt: unknown): string[] {
    const ids: string[] = []
    if (!Array.isArray(prompt)) return ids
    for (const msg of prompt) {
      const m = msg as { role?: unknown; content?: unknown }
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const part of m.content) {
        const p = part as { type?: unknown; toolCallId?: unknown }
        if (p.type === 'tool-call' && typeof p.toolCallId === 'string') ids.push(p.toolCallId)
      }
    }
    return ids
  }

  test('hop-2 executes with NO duplicate assistant history (each toolCallId exactly once)', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const announced: IslandApprovalAnnounce[] = []
    const persisted: unknown[] = []
    const prompts: unknown[] = []
    const settled: Array<{ sessionId: number; status: string }> = []

    // Stateful model: hop-1 resume (A's result folded in) → request tool B (SDK pauses at approval
    // B via needsApproval → guard.register(TC_B) fires for real); hop-2 resume → closing text.
    let modelCall = 0
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt)
        modelCall++
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: TC_B,
                  toolName: 'email_draft_reply',
                  input: JSON.stringify(DRAFT_INPUT_B)
                },
                { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE }
              ]
            })
          }
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '1' },
              { type: 'text-delta' as const, id: '1', delta: '第二封草稿完成。' },
              { type: 'text-end' as const, id: '1' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
            ]
          })
        }
      }
    })

    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      buildTools: (collector, _approvalMode, contextMode) =>
        buildGatewayTools(
          {
            domain: spyDomain(domainCalls),
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        ),
      islandAgentEnabled: true,
      approvalStash: stash,
      announceApprovalToIsland: (info) => {
        announced.push(info)
      },
      isApprovalResolved: (tc: string) => guard.isResolved(tc),
      rejectApproval: (tc: string) => guard.reject(tc),
      // persistTurn MUST be wired: makePersistOnFinish early-returns without it, and the hop-1
      // repause re-stash + re-announce live behind it (matches the production lifecycle).
      persistTurn: (t) => {
        persisted.push(t)
      },
      // live-refresh hook — hop-1 repause must NOT settle the panel (a fresh approval card is live).
      onServerResumeSettled: (sessionId, status) => {
        settled.push({ sessionId, status })
      }
    }
    const h = await start(cfg)
    const tokenA = seedPausedApproval(guard, stash)

    // hop-1: island approves A → tool A executes server-side; the model then requests B → repaused,
    // a FRESH island card (new stash + announce) for B.
    const res1 = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: tokenA })
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.status).toBe('repaused')
    expect(domainCalls).toHaveLength(1)
    expect(announced).toHaveLength(1)
    expect(announced[0].toolCallId).toBe(TC_B)
    expect(persisted).toHaveLength(0) // repaused turn is not a complete turn — nothing persisted yet
    expect(settled).toEqual([]) // repaused is NOT terminal — the panel keeps its live approval card

    // hop-2: island approves B with the re-announced token.
    const res2 = await decide(h.port, {
      toolCallId: TC_B,
      decision: 'approve',
      resumeToken: announced[0].resumeToken
    })
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.ok).toBe(true)
    expect(body2.status).toBe('completed') // NOT error — the second hop really executed
    expect(domainCalls).toHaveLength(2)
    expect((domainCalls[1] as { internalId: number }).internalId).toBe(6)
    expect(persisted).toHaveLength(1) // the completed hop-2 turn persisted exactly once
    expect(settled).toEqual([{ sessionId: 1, status: 'completed' }]) // only the terminal hop settles

    // HIGH-1 regression pin: the hop-2 model prompt carries each tool call EXACTLY once. Before the
    // history id-dedup, the duplicated assistant (same UIMessage id twice) emitted tool-call A twice.
    const hop2Ids = promptToolCallIds(prompts[1])
    expect(hop2Ids.filter((id) => id === TC)).toHaveLength(1)
    expect(hop2Ids.filter((id) => id === TC_B)).toHaveLength(1)
  })
})

// ── S5 W4 (ADR-004 §4.4) — the island resume rebuilds the FROZEN per-agent tool context ──────────
//
// The stash freezes agentRunContext at pause time (from the pause-time server cfg); the resume
// rebuilds cfg through the SAME wrapCfgForAgentRun the fresh spawn used. Pinned here:
//   - the S4 defect fix: the resumed drain keeps the owner's allowedTools narrowing (before this
//     wave the resume used the BASE cfg → full matrix floor);
//   - grants双向: an exec tool inside the grant survives the resumed registration; web (grant_web
//     defaulting 'off') and outbound stay absent even when (mis)listed in allowedTools;
//   - re-pause chain: a second approval inside the resume re-freezes the SAME context (the tool
//     face can never widen across hops).
describe('/api/ai/approval/decide — per-agent context freeze (headless agent resume)', () => {
  // The PRODUCT-real shape (codex终审 P1): allowedTools comes from the Settings picker whose
  // vocabulary is read+domain_write only — it can NOT name exec tools. run_command's presence
  // must come from the grant alone (exec exempt from the intersection), surviving the resume
  // rebuild exactly like the fresh spawn. web_fetch (mis)listed proves the web class stays
  // floored while grant_web is absent (= 'off') — since ADR-004 rev3.1 its absence comes from
  // the web grant row, no longer from "outbound has no key".
  const CTX = {
    agentId: 'dms',
    allowedTools: ['email_draft_reply', 'email_flag', 'web_fetch'],
    // S6 W3 — a real frozen context always carries the resolved mount list (spec-projected);
    // [] here = zero mounts, which only touches the skill-gated read families (none asserted).
    skills: [],
    modeGrants: { exec: true }
  }

  /** spyDomain + the per-agent whitelist evaluate (ask → a second write pauses, no免卡). */
  function headlessDomain(calls: unknown[]): MailAgentDomainClient {
    return {
      draftReply: async (internalId: number, body: string) => {
        calls.push({ internalId, body })
        return { internalId, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
      },
      policyEvaluate: async () => ({ decision: 'ask', rule_id: null })
    } as unknown as MailAgentDomainClient
  }

  /** Model that captures the tool names streamText actually sees, then closes with text. */
  function captureToolsModel(sink: string[][]): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      doStream: async (opts) => {
        sink.push(((opts.tools ?? []) as Array<{ name: string }>).map((t) => t.name))
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '1' },
              { type: 'text-delta' as const, id: '1', delta: 'done' },
              { type: 'text-end' as const, id: '1' },
              {
                type: 'finish' as const,
                finishReason: 'stop' as const,
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 7, text: 7, reasoning: 0 }
                }
              }
            ]
          })
        }
      }
    })
  }

  function headlessCfg(opts: {
    guard: ApprovalGuard
    stash: ApprovalRunStash
    domain: MailAgentDomainClient
    model: MockLanguageModelV3
    seenCtx: Array<{ mode: string | undefined; ctx: unknown }>
  }): AiGatewayConfig {
    return {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => opts.model,
      // forwards the 4th param exactly like the production lifecycle
      buildTools: (collector, _am, contextMode, agentRunContext) => {
        opts.seenCtx.push({ mode: contextMode, ctx: agentRunContext })
        return buildGatewayTools(
          {
            domain: opts.domain,
            writeToolsEnabled: true,
            approvalGuard: opts.guard,
            webToolsEnabled: true,
            execToolsEnabled: true,
            oneShotWrites: true,
            contextMode,
            agentRunContext
          },
          collector
        )
      },
      islandAgentEnabled: true,
      approvalStash: opts.stash,
      announceApprovalToIsland: () => {},
      rejectApproval: (tc: string) => opts.guard.reject(tc),
      persistTurn: () => {}
    }
  }

  function seedHeadlessPause(
    guard: ApprovalGuard,
    stash: ApprovalRunStash,
    ctx: AgentRunContext = CTX
  ): string {
    guard.register(TC, 'email_draft_reply', 'edit', DRAFT_INPUT, ['body_markdown'])
    return stash.stash({
      toolCallId: TC,
      approvalId: AP,
      toolName: 'email_draft_reply',
      sessionId: 1,
      body: { messages: [USER], model: 'claude-sonnet-4-6', sessionId: 1 },
      responseMessage: pausedResponse(),
      contextMode: 'cron_headless',
      agentRunContext: ctx
    })
  }

  test('resume keeps the narrowing + grants: allowedTools ∩ matrix(grants) reaches streamText; approved tool executes', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const seenCtx: Array<{ mode: string | undefined; ctx: unknown }> = []
    const seenTools: string[][] = []
    const cfg = headlessCfg({
      guard,
      stash,
      domain: headlessDomain(domainCalls),
      model: captureToolsModel(seenTools),
      seenCtx
    })
    const h = await start(cfg)
    const token = seedHeadlessPause(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(1) // the approved draft executed server-side

    // buildTools ran under the FROZEN mode AND received the FROZEN context as its 4th param
    expect(seenCtx.length).toBeGreaterThan(0)
    expect(seenCtx[seenCtx.length - 1]).toEqual({ mode: 'cron_headless', ctx: CTX })

    // the model-visible ToolSet (post-intersection): the owner narrowing SURVIVES the resume
    // (S4 defect fix) — un-allowed domain_writes are gone; the granted exec tool is present;
    // outbound stays structurally absent even though the owner (mis)listed web_fetch.
    expect(seenTools.length).toBeGreaterThan(0)
    const names = seenTools[0]
    expect(names).toContain('email_draft_reply')
    expect(names).toContain('email_flag')
    // exec exempt from the intersection: run_command is NOT in allowedTools, the grant alone
    // carries it through the resume rebuild (codex终审 P1 组合案例的 resume 半边)
    expect(names).toContain('run_command')
    expect(names).not.toContain('web_fetch') // grant_web 缺省 'off' → web 类恒缺席（rev3.1 后缺席原因是 web 键 off，非「类型无键」）
    expect(names).not.toContain('email_archive') // not in allowedTools → still narrowed
    expect(names).not.toContain('email_pin')
    expect(names).not.toContain('email_search') // reads outside the allow-list are narrowed too
  })

  test('re-pause chain: a second approval inside the resume re-freezes the SAME context', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const seenCtx: Array<{ mode: string | undefined; ctx: unknown }> = []
    // the resumed model requests a SECOND write (email_flag) → headless + evaluate ask → pause
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'tool-call' as const,
              toolCallId: 'tc_flag_2',
              toolName: 'email_flag',
              input: JSON.stringify({ internal_id: 6, is_flagged: true })
            },
            {
              type: 'finish' as const,
              finishReason: 'tool-calls' as const,
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 7, text: 7, reasoning: 0 }
              }
            }
          ]
        })
      })
    })
    const cfg = headlessCfg({ guard, stash, domain: headlessDomain(domainCalls), model, seenCtx })
    const h = await start(cfg)
    const token = seedHeadlessPause(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('repaused')
    expect(domainCalls).toHaveLength(1) // hop-1's draft executed; the flag is paused, not run

    // the re-stash FROZE the same per-agent context again (the chain never widens)
    const entry = stash.peek('tc_flag_2')
    expect(entry).not.toBeNull()
    expect(entry?.contextMode).toBe('cron_headless')
    expect(entry?.agentRunContext).toEqual(CTX)
  })

  // S6 W3 (ADR-004 rev3.1 §8) — the web grant rides the SAME stash freeze: pause→resume keeps the
  // web tier恒等 (registration + tier semantics rebuilt from the frozen context), and grant='off'
  // (the CTX above) keeps web absent across the resume — pinned by the first test's
  // not.toContain('web_fetch').
  test('resume keeps the web grant: web tools reach streamText after the rebuild; exec stays absent without its own grant', async () => {
    const WEB_CTX = {
      agentId: 'dms',
      allowedTools: ['email_draft_reply'],
      skills: [],
      modeGrants: { exec: false, web: 'gated' as const }
    }
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const seenCtx: Array<{ mode: string | undefined; ctx: unknown }> = []
    const seenTools: string[][] = []
    const cfg = headlessCfg({
      guard,
      stash,
      domain: headlessDomain(domainCalls),
      model: captureToolsModel(seenTools),
      seenCtx
    })
    const h = await start(cfg)
    const token = seedHeadlessPause(guard, stash, WEB_CTX)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')

    // the frozen context (web tier included) reached the rebuild verbatim
    expect(seenCtx[seenCtx.length - 1]).toEqual({ mode: 'cron_headless', ctx: WEB_CTX })
    // the model-visible ToolSet: web class registered under the frozen 'gated' grant (exempt from
    // the intersection — 'web_fetch' is NOT in allowedTools), exec absent without its own grant
    const names = seenTools[0]
    expect(names).toContain('web_fetch')
    expect(names).toContain('web_search')
    expect(names).toContain('email_draft_reply')
    expect(names).not.toContain('run_command')
    expect(names).not.toContain('email_flag') // narrowing survives too
  })

  // S6 W3-1b (rev3.1 §8) — the MOUNT list rides the same stash freeze: a resume rebuilds the exact
  // mount face (mounted family reads present, unmounted family reads absent, collision-exempt floor
  // untouched) — pause→resume can never widen (or shift) the per-agent skill visibility.
  test('resume keeps the mount face: mounted-family reads survive, unmounted-family reads stay absent', async () => {
    const MOUNT_CTX = {
      agentId: 'dms',
      allowedTools: ['email_body', 'email_search_fulltext', 'email_search', 'email_draft_reply'],
      skills: ['email'], // search family NOT mounted — even though allowedTools lists its tool
      modeGrants: { exec: false }
    }
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const seenCtx: Array<{ mode: string | undefined; ctx: unknown }> = []
    const seenTools: string[][] = []
    const cfg = headlessCfg({
      guard,
      stash,
      domain: headlessDomain(domainCalls),
      model: captureToolsModel(seenTools),
      seenCtx
    })
    const h = await start(cfg)
    const token = seedHeadlessPause(guard, stash, MOUNT_CTX)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')

    // the frozen mount list reached the rebuild verbatim
    expect(seenCtx[seenCtx.length - 1]).toEqual({ mode: 'cron_headless', ctx: MOUNT_CTX })
    const names = seenTools[0]
    expect(names).toContain('email_body') // email family mounted + allowed
    expect(names).toContain('email_search') // collision-exempt floor: never mount-gated
    expect(names).toContain('email_draft_reply') // CORE_UNGATED domain_write
    // search family unmounted → absent DESPITE being in allowedTools (mount gate is a pure
    // reduction stacked on the intersection; absence, not an error)
    expect(names).not.toContain('email_search_fulltext')
  })
})
