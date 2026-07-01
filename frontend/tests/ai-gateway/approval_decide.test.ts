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
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
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
  consumed?: (tc: string) => boolean
}): AiGatewayConfig {
  const { guard, stash, domainCalls } = opts
  const domain = spyDomain(domainCalls)
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => mockTextModel(['草稿已创建。']),
    buildTools: (collector) =>
      buildGatewayTools(
        { domain, writeToolsEnabled: true, approvalGuard: guard, oneShotWrites: true },
        collector
      ),
    islandAgentEnabled: true,
    approvalStash: stash,
    isApprovalConsumed: opts.consumed
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
    responseMessage: pausedResponse()
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

  test('single-resolver: renderer already consumed → short-circuit completed, no re-execute', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domainCalls: unknown[] = []
    // isApprovalConsumed returns true → the renderer won the race; /decide must NOT re-run.
    const h = await start(islandCfg({ guard, stash, domainCalls, consumed: () => true }))
    const token = seedPausedApproval(guard, stash)

    const res = await decide(h.port, { toolCallId: TC, decision: 'approve', resumeToken: token })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(domainCalls).toHaveLength(0) // did not re-execute (already done in-app)
  })
})
