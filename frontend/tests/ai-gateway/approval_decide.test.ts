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
import { mayAutoApprove } from '../../src/ai-gateway/tools/policy'
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
