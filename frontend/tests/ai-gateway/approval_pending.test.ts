// GET /api/ai/approval/pending — the pending-approval TRUTH probe (island notice + S6 W1 in-record).
//
// The renderer probes this to decide whether a live, claimable approval exists for a session: a hit
// returns the enriched decide-card body (approvalId / toolName / inputPreview / agentId / jobId /
// ageMs), a MISS returns 404 (fail-closed — the stash is process-memory, gateway restart drops it).
// Read-only (peekBySession never consumes / extends), and the response must NEVER carry the
// resumeToken capability.

import { afterEach, describe, expect, test } from 'vitest'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import type { AgentRunContext } from '../../src/ai-gateway/tools/policy'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** No model call ever happens on this read-only endpoint — base cfg only. */
function baseCfg(over: Partial<AiGatewayConfig> = {}): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    ...over
  }
}

/** A paused assistant message carrying an approval-requested part (so extractApprovalStashInput
 *  yields the input → the endpoint can compute a real inputPreview). */
function pausedResponse(input: unknown): MailAgentUIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-email_draft_reply',
        toolCallId: 'tc_pending',
        state: 'approval-requested',
        input,
        approval: { id: 'ap_pending' }
      }
    ]
  } as unknown as MailAgentUIMessage
}

function seedStash(
  stash: ApprovalRunStash,
  sessionId: number,
  opts: { input?: unknown; agentRunContext?: AgentRunContext } = {}
): string {
  return stash.stash({
    toolCallId: 'tc_pending',
    approvalId: 'ap_pending',
    toolName: 'email_draft_reply',
    sessionId,
    body: { messages: [], model: 'claude-sonnet-4-6', sessionId },
    responseMessage: pausedResponse(opts.input ?? { body_markdown: 'draft body' }),
    ...(opts.agentRunContext ? { agentRunContext: opts.agentRunContext } : {})
  })
}

function pending(port: number, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/approval/pending${query}`)
}

describe('GET /api/ai/approval/pending — hit (enriched decide-card body)', () => {
  test('manual approval → 200 enriched, agentId/jobId null, NO resumeToken leak, read-only', async () => {
    const stash = new ApprovalRunStash()
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash }))
    const token = seedStash(stash, 7)

    const res = await pending(h.port, '?sessionId=7')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.pending).toBe(true) // 向后兼容 island-notice 消费方
    expect(body.approvalId).toBe('ap_pending')
    expect(body.toolName).toBe('email_draft_reply')
    expect(String(body.inputPreview)).toContain('draft body') // 真实 input 预览
    expect(body.agentId).toBeNull()
    expect(body.jobId).toBeNull()
    expect(typeof body.ageMs).toBe('number')
    expect(body.ageMs as number).toBeGreaterThanOrEqual(0)
    // 🔴 the capability token must never leave the gateway through this endpoint
    expect(JSON.stringify(body)).not.toContain(token)
    // read-only: the probe left the entry claimable
    expect(stash.claim('tc_pending', token)).not.toBeNull()
  })

  test('headless agent approval → agentId + jobId from the frozen agentRunContext', async () => {
    const stash = new ApprovalRunStash()
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash }))
    const ctx: AgentRunContext = {
      agentId: 'dms',
      allowedTools: ['email_draft_reply'],
      modeGrants: { exec: false },
      jobId: 99
    }
    seedStash(stash, 12, { agentRunContext: ctx })

    const res = await pending(h.port, '?sessionId=12')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.agentId).toBe('dms')
    expect(body.jobId).toBe(99)
  })
})

describe('GET /api/ai/approval/pending — miss (404 fail-closed)', () => {
  test('no live entry for the session → 404 { pending:false }', async () => {
    const stash = new ApprovalRunStash()
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash }))
    seedStash(stash, 7) // a DIFFERENT session's approval

    const res = await pending(h.port, '?sessionId=8')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ pending: false })
  })

  test('island agent off (no stash wired) → 404 (nothing is claimable)', async () => {
    const h = await start(baseCfg())
    const res = await pending(h.port, '?sessionId=7')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ pending: false })
  })

  test('gateway restart semantics: a FRESH stash instance has no entry → 404', async () => {
    // stash1 held the approval; a restarted gateway constructs a NEW ApprovalRunStash (process
    // memory dropped). Probing the fresh instance → miss → 404 (the honest "已失效（重启）" truth).
    const stash1 = new ApprovalRunStash()
    seedStash(stash1, 7)
    const stash2 = new ApprovalRunStash() // simulate the post-restart gateway
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash2 }))

    const res = await pending(h.port, '?sessionId=7')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ pending: false })
  })

  test('missing / non-integer sessionId → 400 E_INVALID_ARG', async () => {
    const h = await start(
      baseCfg({ islandAgentEnabled: true, approvalStash: new ApprovalRunStash() })
    )
    const missing = await pending(h.port, '')
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toBe('E_INVALID_ARG')
    const malformed = await pending(h.port, '?sessionId=abc')
    expect(malformed.status).toBe(400)
  })
})

// S6 W2 (PRD P8) — the stash presence, NOT cfg.islandAgentEnabled, gates the pending probe. The
// lifecycle now injects the stash whenever server-side resume is live (island OR custom agents), so a
// headless custom-agent pause is claimable in-app with the island OFF. Both flags off → the lifecycle
// leaves the stash undefined → 404 (byte-identical). These pin the gate is the stash, not the island.
describe('GET /api/ai/approval/pending — island-decoupled gate (P8)', () => {
  test('stash present WITHOUT islandAgentEnabled (custom-agents-only) → still hits', async () => {
    const stash = new ApprovalRunStash()
    // islandAgentEnabled omitted (falsy) — the custom-agents lifecycle wires the stash without it.
    const h = await start(baseCfg({ approvalStash: stash }))
    seedStash(stash, 21)

    const res = await pending(h.port, '?sessionId=21')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.pending).toBe(true)
    expect(body.approvalId).toBe('ap_pending')
  })
})
