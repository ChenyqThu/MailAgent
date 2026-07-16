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
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
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

// ── harness-chat lane C (07-15) — capture ↔ explicit-edit mutual exclusion (Node half) ────────────
//
// research lane-c-write-truncation.md §2b/§6①-2: a ~20-25s-later fire-and-forget capture would
// otherwise silently re-digest/reword memory.md right after the user (or an approved agent
// proposal) just explicitly wrote it. When THIS turn's audit shows a SUCCESSFUL
// agent_memory_update, or agent_profile_restore targeting doc_name:'memory', captureTurnMemory
// must be skipped entirely (persistTurn still fires — only capture is gated).

function memoryUpdateEntry(status: 'ok' | 'error' = 'ok'): GatewayToolAuditEntry {
  return {
    toolUseId: 'tu1',
    toolName: 'agent_memory_update',
    inputJson: '{"content":"# MEMORY\\n- x\\n"}',
    outputJson: JSON.stringify({ doc_name: 'memory', content_hash: 'h1' }),
    status,
    durationMs: 5,
    confirmationTier: 'edit',
    approvalStatus: 'approved'
  }
}

function profileRestoreEntry(
  docName: string,
  status: 'ok' | 'error' = 'ok'
): GatewayToolAuditEntry {
  return {
    toolUseId: 'tu1',
    toolName: 'agent_profile_restore',
    inputJson: `{"doc_name":"${docName}","target_hash":"h0"}`,
    outputJson: JSON.stringify({ doc_name: docName, content_hash: 'h1' }),
    status,
    durationMs: 5,
    confirmationTier: 'edit',
    approvalStatus: 'approved'
  }
}

describe('makePersistOnFinish — 07-15 lane C capture ↔ explicit-edit mutual exclusion', () => {
  test('a successful agent_memory_update THIS turn skips captureTurnMemory (persistTurn still fires)', async () => {
    const persisted: PersistTurnInput[] = []
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: (t: PersistTurnInput) => {
        persisted.push(t)
      },
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const run = makeRun({ auditEntries: [memoryUpdateEntry('ok')] })
    await fire(makePersistOnFinish(cfg, run), { responseMessage: asst, isAborted: false })
    expect(persisted).toHaveLength(1)
    expect(captured).toHaveLength(0)
  })

  test('a successful agent_profile_restore(doc_name=memory) THIS turn also skips capture', async () => {
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const run = makeRun({ auditEntries: [profileRestoreEntry('memory', 'ok')] })
    await fire(makePersistOnFinish(cfg, run), { responseMessage: asst, isAborted: false })
    expect(captured).toHaveLength(0)
  })

  test('agent_profile_restore targeting a NON-memory doc (rules/soul/agent/user) does NOT gate capture', async () => {
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const run = makeRun({ auditEntries: [profileRestoreEntry('rules', 'ok')] })
    await fire(makePersistOnFinish(cfg, run), { responseMessage: asst, isAborted: false })
    expect(captured).toHaveLength(1)
  })

  test('a REJECTED/errored agent_memory_update does NOT gate capture (only status:"ok" counts)', async () => {
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const run = makeRun({ auditEntries: [memoryUpdateEntry('error')] })
    await fire(makePersistOnFinish(cfg, run), { responseMessage: asst, isAborted: false })
    expect(captured).toHaveLength(1)
  })

  test('a silent agent_profile_read this turn does NOT gate capture (only the two write tools do)', async () => {
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const readEntry: GatewayToolAuditEntry = {
      toolUseId: 'tu1',
      toolName: 'agent_profile_read',
      inputJson: '{"doc_name":"memory"}',
      outputJson: '{"doc_name":"memory","content":""}',
      status: 'ok',
      durationMs: 5
    }
    const run = makeRun({ auditEntries: [readEntry] })
    await fire(makePersistOnFinish(cfg, run), { responseMessage: asst, isAborted: false })
    expect(captured).toHaveLength(1)
  })

  test('no tool activity this turn (plain chat) does NOT gate capture', async () => {
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: () => {},
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, makeRun()), { responseMessage: asst, isAborted: false })
    expect(captured).toHaveLength(1)
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
