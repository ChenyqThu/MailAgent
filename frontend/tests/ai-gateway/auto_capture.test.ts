// M1c — auto-capture trigger (onFinish fire-and-forget) + domainClient.captureMemory wire shape.
//
// Pure-Node (no chat_db / better-sqlite3): makePersistOnFinish is a pure function over an injected
// AiGatewayConfig, and the domain client is driven by a recording mock fetch. The RED LINE under test:
// captureTurnMemory is fired AFTER persist, is NEVER awaited (a pending/throwing capture cannot block
// the already-streamed reply), is skipped on abort, and is wholly absent (no-op) when the flag is off.

import { describe, expect, test } from 'vitest'

import { makePersistOnFinish, type PreparedChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const asst: MailAgentUIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: '好的，记住了' }]
}

/** Minimal PreparedChatRun — makePersistOnFinish only reads result.usage + sessionId/modelId/
 *  rawMessages/auditEntries. usage resolves to undefined (the catch path). */
function makeRun(over: Partial<PreparedChatRun> = {}): PreparedChatRun {
  return {
    result: { usage: Promise.resolve(undefined) } as unknown as PreparedChatRun['result'],
    rawMessages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '以后中文回我' }] }],
    sessionId: 42,
    modelId: 'claude-sonnet-4-6',
    auditEntries: [],
    toolNames: [],
    ...over
  }
}

// onFinish's argument carries more than these two fields, but makePersistOnFinish only reads
// responseMessage + isAborted — so a narrowed literal cast keeps the test readable.
function fire(
  onFinish: ReturnType<typeof makePersistOnFinish>,
  args: { responseMessage: MailAgentUIMessage; isAborted: boolean }
): Promise<void> {
  return onFinish(args as unknown as Parameters<typeof onFinish>[0])
}

describe('makePersistOnFinish — M1c auto-capture trigger', () => {
  test('fires captureTurnMemory after persistTurn with the finished turn', async () => {
    const seen: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => seen.push(t)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: false })
    expect(seen).toHaveLength(1)
    expect(seen[0].sessionId).toBe(42)
    expect(seen[0].userMessage?.id).toBe('u1')
    expect(seen[0].responseMessage.id).toBe('a1')
  })

  test('flag-off (no captureTurnMemory) → no-op, onFinish still resolves', async () => {
    const cfg = { persistTurn: () => {} } as AiGatewayConfig
    await expect(
      fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: false })
    ).resolves.toBeUndefined()
  })

  test('aborted turn → capture NOT fired', async () => {
    const seen: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => seen.push(t)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: true })
    expect(seen).toHaveLength(0)
  })

  test('red line — capture is never awaited: a pending capture promise does not block onFinish', async () => {
    let started = false
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: () => {
        started = true
        void new Promise(() => {}) // never-resolving fire-and-forget promise
      }
    } as AiGatewayConfig
    // If onFinish awaited the capture, this would hang; it must resolve immediately.
    await expect(
      fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: false })
    ).resolves.toBeUndefined()
    expect(started).toBe(true)
  })

  test('red line — a throwing capture callback does NOT break onFinish (try/catch guard)', async () => {
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: () => {
        throw new Error('capture boom')
      }
    } as AiGatewayConfig
    await expect(
      fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: false })
    ).resolves.toBeUndefined()
  })
})

// ── domainClient.captureMemory wire shape ───────────────────────────────────────────────────────

interface Recorded {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
}

function recordingFetch(responder: (url: string) => { status?: number; json: unknown }): {
  fetchImpl: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {})
    )
    calls.push({ url, method: init?.method, headers, body: init?.body as string | undefined })
    const r = responder(url)
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(fetchImpl: typeof fetch): MailAgentDomainClient {
  return new MailAgentDomainClient({
    baseUrl: 'http://127.0.0.1:8200/api',
    localToken: 'local-tok',
    fetchImpl
  })
}

const success = (data: unknown) => ({ json: { status: 'success', data } })

describe('MailAgentDomainClient.captureMemory — wire shape', () => {
  test('POST /chat/memory/capture with userText+assistantText+sessionId, unwraps data', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      success({ captured: [{ id: 'm1' }], count: 1 })
    )
    const out = await client(fetchImpl).captureMemory({
      userText: 'u',
      assistantText: 'a',
      sessionId: 7
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://127.0.0.1:8200/api/chat/memory/capture')
    expect(JSON.parse(calls[0].body!)).toEqual({ userText: 'u', assistantText: 'a', sessionId: 7 })
    expect(out).toEqual({ captured: [{ id: 'm1' }], count: 1 })
  })

  test('omits sessionId from the wire when null', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ captured: [], count: 0 }))
    await client(fetchImpl).captureMemory({ userText: 'u', assistantText: 'a', sessionId: null })
    expect(JSON.parse(calls[0].body!)).toEqual({ userText: 'u', assistantText: 'a' })
  })
})
