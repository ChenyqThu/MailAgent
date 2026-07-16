// harness-chat lane A (task 07-15, owner拍板「无灵动岛方案优先」) — the FULL approval chain must work
// with MAILAGENT_ISLAND_AGENT_ENABLED explicitly FALSE (and no custom-agents machinery): the in-panel
// approval card is the PRIMARY surface; the island is an optional overlay notification face.
//
// End-to-end against the real gateway: ① a live /api/ai/chat turn pauses at a write-tool approval →
// the run is STASHED (island-independent leg) and NOT announced (announce stays island-gated);
// ② GET /api/ai/approval/pending hits (the in-panel card's truth probe); ③ POST /api/ai/approval/
// decide { approvalId } resumes server-side and the tool REALLY executes. Mirrors the production
// lifecycle wiring after the 07-15 decoupling (serverResumeEnabled unconditional, oneShotWrites on,
// isApprovalResolved/rejectApproval always injected, islandAgentEnabled: false).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type {
  AiGatewayConfig,
  IslandApprovalAnnounce,
  PersistTurnInput
} from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { ApprovalRunStash, DEFAULT_STASH_TTL_MS } from '../../src/ai-gateway/approvalStash'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
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

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}
const TC = 'tc_draft_off'
const DRAFT_INPUT = { internal_id: 9, body_markdown: 'island-off draft' }

/** Call 1: the model streams a short preamble then proposes the write tool (→ needsApproval pause;
 *  the preamble keeps the redacted paused persist displayable). Call 2 (the resume): closing text.
 *  🔴 Stateful ACROSS requests — instantiate ONCE per test and return the same instance from
 *  cfg.createModel (a per-request fresh instance would re-propose the tool on the resume). */
function twoPhaseModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '0' },
              { type: 'text-delta' as const, id: '0', delta: '我来起草。' },
              { type: 'text-end' as const, id: '0' },
              {
                type: 'tool-call' as const,
                toolCallId: TC,
                toolName: 'email_draft_reply',
                input: JSON.stringify(DRAFT_INPUT)
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
            { type: 'text-delta' as const, id: '1', delta: '草稿已创建。' },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
          ]
        })
      }
    }
  })
}

test('island flag explicitly OFF → pause stashes (no announce) → /pending hits → in-panel /decide executes the tool', async () => {
  const domainCalls: unknown[] = []
  const domain = {
    draftReply: async (internalId: number, body: string) => {
      domainCalls.push({ internalId, body })
      return { internalId, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
    }
  } as unknown as MailAgentDomainClient
  const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
  const stash = new ApprovalRunStash()
  const announced: IslandApprovalAnnounce[] = []
  const persisted: PersistTurnInput[] = []
  const paused: MailAgentUIMessage[] = []
  const model = twoPhaseModel() // ONE stateful instance across pause + resume

  // Mirrors ai_gateway_lifecycle.ts AFTER the 07-15 decoupling, with the island env flag FALSE.
  const cfg: AiGatewayConfig = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => model,
    buildTools: (collector, _approvalMode, contextMode) =>
      buildGatewayTools(
        {
          domain,
          writeToolsEnabled: true,
          approvalGuard: guard,
          oneShotWrites: true, // serverResumeEnabled → always one-shot (cross-surface resolver)
          contextMode
        },
        collector
      ),
    islandAgentEnabled: false, // ← the owner-mandated scenario
    serverResumeEnabled: true, // 07-15 — unconditional in the lifecycle
    approvalStash: stash,
    announceApprovalToIsland: (info) => announced.push(info), // must stay silent (island-gated leg)
    isApprovalResolved: (tc: string) => guard.isResolved(tc),
    rejectApproval: (tc: string) => guard.reject(tc),
    persistTurn: (t) => {
      persisted.push(t)
    },
    persistPausedAssistant: (_sid, msg) => {
      paused.push(msg)
    }
  }
  const h = await start(cfg)

  // ① first live turn — pauses at the approval gate (real needsApproval path, no hand-seeding).
  const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 77,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我起草回复' }] }]
    })
  })
  expect(res.status).toBe(200)
  await res.text() // drain the paused stream
  await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
  expect(announced).toHaveLength(0) // the announce leg is island-gated — flag off ⇒ silent
  expect(paused).toHaveLength(1) // R2-3 redacted eager persist still ran
  expect(persisted).toHaveLength(0) // a paused turn is not a complete turn

  // ② the in-panel card's truth probe hits.
  const pendingRes = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=77`)
  expect(pendingRes.status).toBe(200)
  const pending = (await pendingRes.json()) as {
    pending: boolean
    approvalId: string
    toolName: string
  }
  expect(pending.pending).toBe(true)
  expect(pending.toolName).toBe('email_draft_reply')

  // ③ in-panel decide ({ approvalId } shape — no capability token) → server-side resume → REAL write.
  const decideRes = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
  })
  expect(decideRes.status).toBe(200)
  const decided = (await decideRes.json()) as { ok: boolean; status: string }
  expect(decided.ok).toBe(true)
  expect(decided.status).toBe('completed')
  expect(domainCalls).toHaveLength(1)
  expect((domainCalls[0] as { internalId: number }).internalId).toBe(9)
  // the resumed complete turn persisted exactly once; still zero island announces.
  expect(persisted).toHaveLength(1)
  expect(announced).toHaveLength(0)
})

// check pass (07-15) — B1 × approval: a turn that PAUSES at an approval gate still terminates its
// UIMessage stream, so the detached drain's finally MUST release the registry entry. Without that,
// the renderer's resume-after-approval leg (a SECOND POST /api/ai/chat for the same session,
// sendAutomaticallyWhen) would be 409'd and approvals would break with detached runs default-ON.
describe('B1 detached runs × approval pause — the paused turn frees the session', () => {
  test('pause → /run/active 404 (registry released) → a second POST for the SAME session is NOT 409d', async () => {
    const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    const stash = new ApprovalRunStash()
    const registry = new ActiveRunRegistry()
    const persisted: PersistTurnInput[] = []
    const domain = {
      draftReply: async () => ({
        internalId: 9,
        mailbox: '草稿箱',
        accountName: 'acct',
        draftId: 'd1'
      })
    } as unknown as MailAgentDomainClient
    const model = twoPhaseModel() // call 1 pauses at the write tool; call 2 completes
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      buildTools: (collector, _am, contextMode) =>
        buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        ),
      islandAgentEnabled: false,
      serverResumeEnabled: true,
      approvalStash: stash,
      detachedRunsEnabled: true,
      activeRuns: registry,
      isApprovalResolved: (tc: string) => guard.isResolved(tc),
      rejectApproval: (tc: string) => guard.reject(tc),
      persistTurn: (t) => {
        persisted.push(t)
      }
    }
    const h = await start(cfg)

    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 79,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草回复' }] }]
      })
    })
    expect(res.status).toBe(200)
    await res.text() // drain the paused stream to its end
    await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })

    // the paused (terminated) stream released the registry — nothing "active" for the session
    expect(registry.hasActive(79)).toBe(false)
    const active = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=79`)
    expect(active.status).toBe(404)

    // the renderer resume leg: a SECOND POST for the same session must be accepted (not 409)
    const res2 = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 79,
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '继续' }] }]
      })
    })
    expect(res2.status).toBe(200)
    await res2.text()
    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    expect(registry.hasActive(79)).toBe(false)
  })
})

// P1-1 (codex r1) — /decide is a fail-closed security floor: ONLY the exact strings 'approve' /
// 'reject' are accepted. A missing field, 'rejected', a case variant or any other value must answer
// 400 WITHOUT claiming/consuming the stash (the pre-fix code defaulted everything ≠ 'reject' to
// APPROVE — a malformed body would execute a real write tool).
describe('P1-1 — /decide strict decision validation (fail-closed)', () => {
  test('missing / unknown / case-variant decision → 400, stash untouched, tool never runs; exact approve still works after', async () => {
    const domainCalls: unknown[] = []
    const domain = {
      draftReply: async (internalId: number, body: string) => {
        domainCalls.push({ internalId, body })
        return { internalId, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
      }
    } as unknown as MailAgentDomainClient
    const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    const stash = new ApprovalRunStash()
    const model = twoPhaseModel()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      buildTools: (collector, _am, contextMode) =>
        buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        ),
      islandAgentEnabled: false,
      serverResumeEnabled: true,
      approvalStash: stash,
      isApprovalResolved: (tc: string) => guard.isResolved(tc),
      rejectApproval: (tc: string) => guard.reject(tc),
      persistTurn: () => {}
    }
    const h = await start(cfg)
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 81,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
      })
    })
    await res.text()
    await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
    const pending = (await (
      await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=81`)
    ).json()) as { approvalId: string }

    const decide = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    // The regression matrix: missing field / the tempting-but-wrong 'rejected' / case variant /
    // arbitrary value / non-string. Every one → 400 E_INVALID_ARG, nothing executed, stash intact.
    for (const bad of [
      { approvalId: pending.approvalId }, // missing decision — the pre-fix default-approve shape
      { approvalId: pending.approvalId, decision: 'rejected' },
      { approvalId: pending.approvalId, decision: 'Approve' },
      { approvalId: pending.approvalId, decision: 'yes' },
      { approvalId: pending.approvalId, decision: 1 }
    ]) {
      const r = await decide(bad)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe('E_INVALID_ARG')
    }
    expect(domainCalls).toHaveLength(0) // fail-closed: the write tool never ran
    expect(stash.size()).toBe(1) // …and the approval is still claimable
    const stillPending = await fetch(
      `http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=81`
    )
    expect(stillPending.status).toBe(200)

    // A corrected retry with the EXACT string still works (the 400s consumed nothing).
    const ok = await decide({ approvalId: pending.approvalId, decision: 'approve' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe('completed')
    expect(domainCalls).toHaveLength(1)
  })
})

// P1-2 (codex r1) — the server-side resume must hold the SAME per-session lease as a normal chat
// turn (ActiveRunRegistry): without it a user could POST /api/ai/chat while the resume streams and
// the two runs would interleave their persistence (行序交错). Both directions are pinned.
describe('P1-2 — approval resume holds the per-session run lease', () => {
  /** call 1 = pause at the write tool; call 2 = SLOW resume completion (a window to race against);
   *  call 3 = fast completion (direction-2's second decide). */
  function threePhaseModel(slowCall: 2 | 3 | null): MockLanguageModelV3 {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: '0' },
                { type: 'text-delta' as const, id: '0', delta: '我来起草。' },
                { type: 'text-end' as const, id: '0' },
                {
                  type: 'tool-call' as const,
                  toolCallId: TC,
                  toolName: 'email_draft_reply',
                  input: JSON.stringify(DRAFT_INPUT)
                },
                { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE }
              ]
            })
          }
        }
        const slow = call === slowCall
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: slow ? 80 : 0,
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '1' },
              ...['完', '成', '一', '二', '三', '四'].map((delta) => ({
                type: 'text-delta' as const,
                id: '1',
                delta
              })),
              { type: 'text-end' as const, id: '1' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
            ]
          })
        }
      }
    })
  }

  function leaseCfg(opts: {
    model: MockLanguageModelV3
    guard: ApprovalGuard
    stash: ApprovalRunStash
    registry: ActiveRunRegistry
    domain: MailAgentDomainClient
    persisted: PersistTurnInput[]
    /** codex r2 [A] — false models the production ROLLBACK shape: detached drain off, registry
     *  still wired (the lifecycle now builds it unconditionally). Default true. */
    detached?: boolean
  }): AiGatewayConfig {
    return {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => opts.model,
      buildTools: (collector, _am, contextMode) =>
        buildGatewayTools(
          {
            domain: opts.domain,
            writeToolsEnabled: true,
            approvalGuard: opts.guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        ),
      islandAgentEnabled: false,
      serverResumeEnabled: true,
      approvalStash: opts.stash,
      detachedRunsEnabled: opts.detached !== false,
      activeRuns: opts.registry,
      isApprovalResolved: (tc: string) => opts.guard.isResolved(tc),
      rejectApproval: (tc: string) => opts.guard.reject(tc),
      persistTurn: (t) => {
        opts.persisted.push(t)
      }
    }
  }

  const draftDomain = (): MailAgentDomainClient =>
    ({
      draftReply: async () => ({
        internalId: 9,
        mailbox: '草稿箱',
        accountName: 'acct',
        draftId: 'd1'
      })
    }) as unknown as MailAgentDomainClient

  test('resume in flight → /run/active true + same-session POST 409; lease released on settle', async () => {
    const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    const stash = new ApprovalRunStash()
    const registry = new ActiveRunRegistry()
    const persisted: PersistTurnInput[] = []
    const model = threePhaseModel(2) // the resume (call 2) streams slowly — the race window
    const h = await start(
      leaseCfg({ model, guard, stash, registry, domain: draftDomain(), persisted })
    )

    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 91,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
      })
    })
    await res.text()
    await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
    expect(registry.hasActive(91)).toBe(false) // paused turn released its slot
    const pending = (await (
      await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=91`)
    ).json()) as { approvalId: string }

    // Fire the decide WITHOUT awaiting — the slow resume keeps the lease held for the assertions.
    const decideP = fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
    })
    await vi.waitFor(() => expect(registry.hasActive(91)).toBe(true), { timeout: 3000 })

    // /run/active reflects the resume…
    const active = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=91`)
    expect(active.status).toBe(200)
    expect(((await active.json()) as { active: boolean }).active).toBe(true)
    // …and a same-session POST /api/ai/chat is 409-fenced (no interleaved second turn).
    const raced = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 91,
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '再来' }] }]
      })
    })
    expect(raced.status).toBe(409)
    expect(((await raced.json()) as { error: string }).error).toBe('E_RUN_ACTIVE')

    const decided = (await (await decideP).json()) as { ok: boolean; status: string }
    expect(decided.ok).toBe(true)
    expect(decided.status).toBe('completed')
    // settle: lease released by runId, resumed turn persisted exactly once.
    expect(registry.hasActive(91)).toBe(false)
    expect(registry.size()).toBe(0)
    expect(persisted).toHaveLength(1)
  })

  test('a live chat run for the session → /decide 409 and the stash stays claimable (retry works)', async () => {
    const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    const stash = new ApprovalRunStash()
    const registry = new ActiveRunRegistry()
    const persisted: PersistTurnInput[] = []
    const domainCalls: unknown[] = []
    const domain = {
      draftReply: async () => {
        domainCalls.push(1)
        return { internalId: 9, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
      }
    } as unknown as MailAgentDomainClient
    const model = threePhaseModel(2) // call 2 = the NEW turn here (slow); call 3 = the retry resume
    const h = await start(leaseCfg({ model, guard, stash, registry, domain, persisted }))

    // turn 1 pauses at the approval gate (slot released, stash live).
    const res1 = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 92,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
      })
    })
    await res1.text()
    await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
    const pending = (await (
      await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=92`)
    ).json()) as { approvalId: string }

    // turn 2: a NEW user message starts streaming (slow) — it holds the session lease.
    const res2P = fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 92,
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '先聊别的' }] }]
      })
    })
    await vi.waitFor(() => expect(registry.hasActive(92)).toBe(true), { timeout: 3000 })

    // /decide while the chat run streams → 409, stash NOT claimed (retryable), nothing executed.
    const blocked = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
    })
    expect(blocked.status).toBe(409)
    const blockedBody = (await blocked.json()) as { ok: boolean; error: string }
    expect(blockedBody.ok).toBe(false)
    expect(blockedBody.error).toContain('E_RUN_ACTIVE')
    expect(stash.size()).toBe(1)
    expect(domainCalls).toHaveLength(0)

    // the chat run settles → the SAME decide now succeeds (stash was left intact).
    await (await res2P).text()
    await vi.waitFor(() => expect(registry.hasActive(92)).toBe(false), { timeout: 3000 })
    const retry = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
    })
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { status: string }).status).toBe('completed')
    expect(domainCalls).toHaveLength(1)
    expect(registry.size()).toBe(0)
  })

  // codex r2 [A] — the SAME two directions under the production ROLLBACK configuration
  // (MAILAGENT_CHAT_DETACHED_RUNS=false): the lifecycle now builds the ActiveRunRegistry
  // unconditionally, so the approval-resume mutex must hold with the detached drain off too —
  // the r1 fix left the registry uncreated there, fully re-opening the original P1-2 race.
  describe('detached-OFF (rollback shape) keeps the approval-resume mutex', () => {
    test('resume in flight → /run/active true + same-session POST 409; slot released on settle', async () => {
      const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
      const stash = new ApprovalRunStash()
      const registry = new ActiveRunRegistry()
      const persisted: PersistTurnInput[] = []
      const model = threePhaseModel(2) // the resume (call 2) streams slowly — the race window
      const h = await start(
        leaseCfg({
          model,
          guard,
          stash,
          registry,
          domain: draftDomain(),
          persisted,
          detached: false
        })
      )

      // turn 1 pauses at the approval gate — an ATTACHED stream now; draining it to the end fires
      // the response 'close', which is the off-branch release point (占槽/释放接线).
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 95,
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
        })
      })
      expect(res.status).toBe(200)
      await res.text()
      await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
      await vi.waitFor(() => expect(registry.hasActive(95)).toBe(false), { timeout: 3000 })

      const pending = (await (
        await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=95`)
      ).json()) as { approvalId: string }

      // Fire the decide WITHOUT awaiting — the slow resume keeps the lease held for the assertions.
      const decideP = fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
      })
      await vi.waitFor(() => expect(registry.hasActive(95)).toBe(true), { timeout: 3000 })

      const active = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=95`)
      expect(active.status).toBe(200)
      expect(((await active.json()) as { active: boolean }).active).toBe(true)
      const raced = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 95,
          messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '再来' }] }]
        })
      })
      expect(raced.status).toBe(409)
      expect(((await raced.json()) as { error: string }).error).toBe('E_RUN_ACTIVE')

      const decided = (await (await decideP).json()) as { ok: boolean; status: string }
      expect(decided.ok).toBe(true)
      expect(decided.status).toBe('completed')
      expect(registry.hasActive(95)).toBe(false)
      expect(registry.size()).toBe(0)
      expect(persisted).toHaveLength(1)
    })

    test('a live ATTACHED chat run → /decide 409, stash intact; retry works after the run settles', async () => {
      const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
      const stash = new ApprovalRunStash()
      const registry = new ActiveRunRegistry()
      const persisted: PersistTurnInput[] = []
      const domainCalls: unknown[] = []
      const domain = {
        draftReply: async () => {
          domainCalls.push(1)
          return { internalId: 9, mailbox: '草稿箱', accountName: 'acct', draftId: 'd1' }
        }
      } as unknown as MailAgentDomainClient
      const model = threePhaseModel(2) // call 2 = the NEW attached turn (slow); call 3 = the retry resume
      const h = await start(
        leaseCfg({ model, guard, stash, registry, domain, persisted, detached: false })
      )

      const res1 = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 96,
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
        })
      })
      await res1.text()
      await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
      const pending = (await (
        await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=96`)
      ).json()) as { approvalId: string }

      // turn 2: a NEW user message streams ATTACHED (slow) — it holds the session slot.
      const res2P = fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 96,
          messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '先聊别的' }] }]
        })
      })
      await vi.waitFor(() => expect(registry.hasActive(96)).toBe(true), { timeout: 3000 })

      const blocked = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
      })
      expect(blocked.status).toBe(409)
      expect(stash.size()).toBe(1)
      expect(domainCalls).toHaveLength(0)

      // the attached run settles (drain to end → response close → release) → the retry succeeds.
      await (await res2P).text()
      await vi.waitFor(() => expect(registry.hasActive(96)).toBe(false), { timeout: 3000 })
      const retry = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: pending.approvalId, decision: 'approve' })
      })
      expect(retry.status).toBe(200)
      expect(((await retry.json()) as { status: string }).status).toBe('completed')
      expect(domainCalls).toHaveLength(1)
      expect(registry.size()).toBe(0)
    })
  })
})

describe('serverResumeEnabled gates the cross-surface single-resolver semantics (no island flag)', () => {
  // Minimal makePersistOnFinish-level pins live in persist_approval_gate.test.ts for the island
  // flag; here the gateway-level reject path proves the tombstone works island-off: an in-panel
  // REJECT tombstones the guard so any later approve fails closed.
  test('in-panel reject (island off) tombstones the guard', async () => {
    const guard = new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    const domain = {
      draftReply: async () => {
        domainCalls.push(1)
        return {}
      }
    } as unknown as MailAgentDomainClient
    const model = twoPhaseModel() // ONE stateful instance across pause + resume
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      buildTools: (collector, _am, contextMode) =>
        buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        ),
      islandAgentEnabled: false,
      serverResumeEnabled: true,
      approvalStash: stash,
      isApprovalResolved: (tc: string) => guard.isResolved(tc),
      rejectApproval: (tc: string) => guard.reject(tc),
      persistTurn: () => {}
    }
    const h = await start(cfg)
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 78,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '起草' }] }]
      })
    })
    await res.text()
    await vi.waitFor(() => expect(stash.size()).toBe(1), { timeout: 3000 })
    const pending = (await (
      await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/pending?sessionId=78`)
    ).json()) as { approvalId: string }

    const decideRes = await fetch(`http://127.0.0.1:${h.port}/api/ai/approval/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: pending.approvalId, decision: 'reject' })
    })
    expect(((await decideRes.json()) as { status: string }).status).toBe('rejected')
    expect(domainCalls).toHaveLength(0) // rejected → the write never ran
    expect(guard.isResolved(TC)).toBe(true) // tombstoned — a later approve on any surface fails closed
  })
})
