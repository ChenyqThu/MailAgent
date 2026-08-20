// codex r2 [B] (task 07-15 harness-chat) — every post-register throw path in handleChat must
// release the ActiveRunRegistry slot. r1 put the detached drain inside try/finally but left
// `run.result.toUIMessageStream(streamOptions)` OUTSIDE the protected region: a synchronous throw
// there skipped the finally and stranded the slot for 15 min (every subsequent same-session POST →
// 409 E_RUN_ACTIVE until the stale sweep).
//
// A real StreamTextResult can't be made to throw synchronously from cfg alone, so this harness
// overrides prepareChatRun (module mock, actual implementation untouched otherwise) to hand back a
// crafted run whose toUIMessageStream throws — a REAL sync throw through the REAL handler.

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { PrepareChatOutcome } from '../../src/ai-gateway/chatRun'

const { prepareOverrideRef } = vi.hoisted(() => ({
  prepareOverrideRef: { current: null as (() => PrepareChatOutcome) | null }
}))

vi.mock('../../src/ai-gateway/chatRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai-gateway/chatRun')>()
  return {
    ...actual,
    prepareChatRun: (...args: Parameters<typeof actual.prepareChatRun>) =>
      prepareOverrideRef.current
        ? Promise.resolve(prepareOverrideRef.current())
        : actual.prepareChatRun(...args)
  }
})

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { PreparedChatRun } from '../../src/ai-gateway/chatRun'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  prepareOverrideRef.current = null
  while (handles.length) await handles.pop()!.close()
  vi.restoreAllMocks()
})

/** A crafted run whose toUIMessageStream throws SYNCHRONOUSLY (the codex r2 [B] path). */
function throwingRun(sessionId: number): PreparedChatRun {
  return {
    result: {
      toUIMessageStream: () => {
        throw new Error('sync boom from toUIMessageStream')
      }
    } as unknown as PreparedChatRun['result'],
    rawMessages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }
    ] as unknown as MailAgentUIMessage[],
    sessionId,
    modelId: 'mock-model',
    // 真的 prepareChatRun 在测试这条路径（cfg.createModel 注入假模型）上恒写 'anthropic'
    // —— 见 resolveModelFactory 的 createModel 分支。protocol 只被带进持久化的 turn。
    protocol: 'anthropic',
    auditEntries: [],
    toolNames: []
  }
}

describe('codex r2 [B] — toUIMessageStream sync throw releases the registry slot', () => {
  test('detached run: sync throw after register → slot released, session immediately reusable', async () => {
    const persisted: PersistTurnInput[] = []
    const registry = new ActiveRunRegistry()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      detachedRunsEnabled: true,
      activeRuns: registry,
      persistTurn: (t) => {
        persisted.push(t)
      }
    }
    const h = await start(cfg)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    prepareOverrideRef.current = () => ({ ok: true, run: throwingRun(61) })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 61,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }]
      })
    })
    await res.text() // the finally ends the (headerless) response — reading it proves no wedge
    // the throw was caught + logged; nothing persisted (the stream never drained)
    expect(persisted).toHaveLength(0)
    expect(errSpy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('sync boom'))).toBe(true)

    // 🔴 the point: the slot is NOT stranded — released in the finally despite the sync throw.
    expect(registry.size()).toBe(0)
    const active = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=61`)
    expect(active.status).toBe(404)

    // and the session is immediately reusable (a leaked slot would answer 409 E_RUN_ACTIVE here).
    prepareOverrideRef.current = () => ({ ok: true, run: throwingRun(61) })
    const res2 = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 61,
        messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'again' }] }]
      })
    })
    expect(res2.status).not.toBe(409)
    await res2.text()
    expect(registry.size()).toBe(0)
  })

  test('attached (detached-off) run: sync pipe throw after register → slot released', async () => {
    const registry = new ActiveRunRegistry()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      detachedRunsEnabled: false,
      activeRuns: registry,
      persistTurn: () => {}
    }
    const h = await start(cfg)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // the attached branch calls pipeUIMessageStreamToResponse — make THAT throw synchronously.
    prepareOverrideRef.current = () => ({
      ok: true,
      run: {
        ...throwingRun(62),
        result: {
          pipeUIMessageStreamToResponse: () => {
            throw new Error('sync pipe boom')
          }
        } as unknown as PreparedChatRun['result']
      }
    })
    await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 62,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }]
      })
    }).catch(() => null) // the handler destroys the response — a fetch error is acceptable here
    await vi.waitFor(() => expect(registry.size()).toBe(0), { timeout: 3000 })
  })
})
