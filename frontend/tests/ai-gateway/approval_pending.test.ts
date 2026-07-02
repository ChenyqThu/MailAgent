// Part B follow-up — GET /api/ai/approval/pending (reloaded-session pending-approval probe).
//
// The renderer probes this after seeding a history session: a paused approval persisted REDACTED
// (R2-3) leaves no card on reload, but with island agent on the approval may still be LIVE in the
// gateway stash — pending:true drives the "act on the island" notice. Read-only (peekBySession),
// and the response must NEVER carry the resumeToken capability.

import { afterEach, describe, expect, test } from 'vitest'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
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

function seedStash(stash: ApprovalRunStash, sessionId: number): string {
  return stash.stash({
    toolCallId: 'tc_pending',
    approvalId: 'ap_pending',
    toolName: 'email_draft_reply',
    sessionId,
    body: { messages: [], model: 'claude-sonnet-4-6', sessionId },
    responseMessage: { id: 'a1', role: 'assistant', parts: [] } as unknown as MailAgentUIMessage
  })
}

function pending(port: number, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/approval/pending${query}`)
}

describe('GET /api/ai/approval/pending', () => {
  test('live stash for the session → pending:true + toolName, and NO resumeToken leak', async () => {
    const stash = new ApprovalRunStash()
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash }))
    const token = seedStash(stash, 7)

    const res = await pending(h.port, '?sessionId=7')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ pending: true, toolName: 'email_draft_reply' })
    // 🔴 the capability token must never leave the gateway through this endpoint
    expect(JSON.stringify(body)).not.toContain(token)
    // read-only: the probe left the entry claimable
    expect(stash.claim('tc_pending', token)).not.toBeNull()
  })

  test('no live entry for the session → pending:false', async () => {
    const stash = new ApprovalRunStash()
    const h = await start(baseCfg({ islandAgentEnabled: true, approvalStash: stash }))
    seedStash(stash, 7) // a DIFFERENT session's approval

    const res = await pending(h.port, '?sessionId=8')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pending: false })
  })

  test('island agent off (no stash wired) → pending:false (200, not 404)', async () => {
    const h = await start(baseCfg())
    const res = await pending(h.port, '?sessionId=7')
    expect(res.status).toBe(200)
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
