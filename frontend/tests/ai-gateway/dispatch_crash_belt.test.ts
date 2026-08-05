// 08-04 (task 08-01 messenger) — the dispatcher's crash belt.
//
// Regression pin for a 30-minute SILENT HANG. server.ts launched every route fire-and-forget as
// `void handleX(req, res, cfg)`, so an unhandled throw inside a handler rejected a floating
// promise and the response was NEVER WRITTEN — no status, no body, socket held open. The live
// trigger: prepareChatRun maps only the typed ProviderCredentialsError to 503 and RE-THROWS every
// other resolver failure, and providers.ts::resolveFromRegistry answers an unknown provider ref
// with a bare `Error('No enabled LLM provider: X')`. One typo in a model ref → /api/ai/chat and
// /api/ai/im-chat answered nothing at all; the 飞书 bridge (src/im/gateway_client.py,
// CHAT_READ_TIMEOUT_SEC = 1800) then sat on that socket for half an hour.
//
// What this pins:
//   1. a crashing handler answers IMMEDIATELY — 500 + JSON E_INTERNAL — on BOTH chat entrypoints;
//   2. the belt is a floor, NOT a re-classifier: the typed credentials failure is still 503
//      E_NO_LLM_KEY through the handler's own path (prepareChatRun untouched);
//   3. the crash is logged as a SUMMARY ({name, message}), never the error object — SDK errors
//      carry the request body, i.e. the user's message text (PRD Technical Notes ①).

import { afterEach, describe, expect, test, vi } from 'vitest'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import {
  parseProviderRef,
  ProviderCredentialsError,
  type ProviderModelResolver,
  type ResolvedProviderModel
} from '../../src/ai-gateway/providerRef'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
  vi.restoreAllMocks()
})

/** Mirrors providers.ts::resolveFromRegistry's two failure shapes: a bare Error for an unknown
 *  provider id (the hang's trigger) and the TYPED credentials error for a keyless row. */
const resolver: ProviderModelResolver = {
  resolve: async (ref: string): Promise<ResolvedProviderModel> => {
    const { providerId } = parseProviderRef(ref)
    if (providerId === 'nokey') {
      throw new ProviderCredentialsError(`LLM provider ${providerId} 缺少 API key`)
    }
    throw new Error(`No enabled LLM provider: ${providerId}`)
  }
}

const CFG: AiGatewayConfig = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6',
  imFeishuEnabled: true,
  providerRegistryEnabled: true,
  providerModelResolver: resolver
}

/** POST with a hard deadline. A hang is the exact failure this file exists to catch, so the abort
 *  is turned into an explicit assertion failure — and aborting (rather than merely racing a timer)
 *  frees the socket so afterEach's server.close() can't wedge on the stuck request. */
const DEADLINE_MS = 3000
async function post(port: number, path: string, body: unknown): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DEADLINE_MS)
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error(
        `POST ${path} never answered within ${DEADLINE_MS}ms — the dispatcher swallowed the handler rejection`
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function userTurn(text: string): unknown {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
}

describe('gateway dispatcher — unhandled handler rejection never hangs the client', () => {
  test('/api/ai/im-chat with an unknown provider ref → immediate 500 E_INTERNAL (not a 30-min hang)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await start(CFG)

    const res = await post(h.port, '/api/ai/im-chat', {
      messages: userTurn('hi'),
      model: 'nonexistent:foo'
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: string; hint?: string }
    expect(body.error).toBe('E_INTERNAL')
    expect(body.hint).toContain('No enabled LLM provider: nonexistent')

    // Logged, and logged as a SUMMARY — the raw Error object must never be handed to the logger.
    const crash = logged.mock.calls.find((c) => String(c[0]).includes('/api/ai/im-chat'))
    expect(crash).toBeDefined()
    expect(crash![1]).toEqual({ name: 'Error', message: 'No enabled LLM provider: nonexistent' })
    expect(crash![1]).not.toBeInstanceOf(Error)
  })

  test('/api/ai/chat with an unknown provider ref → immediate 500 E_INTERNAL (same belt)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await start(CFG)

    const res = await post(h.port, '/api/ai/chat', {
      messages: userTurn('hi'),
      model: 'nonexistent:foo'
    })

    expect(res.status).toBe(500)
    expect(((await res.json()) as { error?: string }).error).toBe('E_INTERNAL')
  })

  test('the belt does NOT re-classify: a typed credentials failure is still 503 E_NO_LLM_KEY', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await start(CFG)

    for (const path of ['/api/ai/chat', '/api/ai/im-chat']) {
      const res = await post(h.port, path, { messages: userTurn('hi'), model: 'nokey:some-model' })
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error?: string }).error).toBe('E_NO_LLM_KEY')
    }
  })

  test('handler-owned error mapping still wins (400 shape checks answer before the belt)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await start(CFG)

    // Empty messages[] is prepareChatRun's own 400 — it must never reach the crash belt.
    const res = await post(h.port, '/api/ai/im-chat', { messages: [] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe('E_INVALID_ARG')
  })
})
