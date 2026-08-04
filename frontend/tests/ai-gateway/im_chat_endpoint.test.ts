// Stage 2 PR-1 (task 08-01 messenger, MAILAGENT_IM_FEISHU) — POST /api/ai/im-chat.
//
// Pins the entrypoint contract the PR-3 飞书 bridge builds on:
//   1. flag OFF (cfg.imFeishuEnabled absent/false) → 404, and /api/ai/chat is byte-identical
//      (still manual_chat, still streams) — the gateway-level rollback shape;
//   2. flag ON → the endpoint streams the SAME UIMessage SSE as /api/ai/chat, but the run is
//      prepared under the TRUSTED 'im_chat' mode (asserted in server code, never the body);
//   3. first turn (no sessionId) → cfg.createImSession pre-creates the origin='im' session, the
//      response advertises it via the `x-mailagent-session-id` header, and persistTurn lands on
//      that session; a later turn carrying sessionId does NOT create again (echoes the id);
//   4. createImSession failure/null → the run still streams (unsaved), no session header;
//   5. the per-session 409 (E_RUN_ACTIVE) fence guards im runs exactly like manual ones.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import type { AgentContextMode } from '../../src/ai-gateway/tools/policy'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

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

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim()
      if (!line || line === '[DONE]') continue
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* skip non-json frames */
      }
    }
  }
  return frames
}

const BASE_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

function userTurn(text: string): unknown {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
}

function postImChat(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/im-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('POST /api/ai/im-chat — flag gate (MAILAGENT_IM_FEISHU)', () => {
  test('flag off/absent → 404 not_found; /api/ai/chat unaffected (byte-level gateway fallback)', async () => {
    const modes: Array<AgentContextMode | undefined> = []
    const h = await start({
      ...BASE_CFG,
      createModel: () => mockTextModel(['ok']),
      buildTools: (_collector, _approvalMode, contextMode) => {
        modes.push(contextMode)
        return {}
      }
      // imFeishuEnabled deliberately ABSENT — the default (off) shape.
    })
    const res = await postImChat(h.port, { messages: userTurn('hi') })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toBe('not_found')
    // No run was prepared for the 404 (buildTools untouched by the refused route).
    expect(modes).toEqual([])
    // The canonical endpoint still streams under manual_chat.
    const chat = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    expect(chat.status).toBe(200)
    await readSse(chat)
    expect(modes).toEqual(['manual_chat'])
  })

  test('explicit imFeishuEnabled:false → 404 too (only the exact true registers the route)', async () => {
    const h = await start({
      ...BASE_CFG,
      imFeishuEnabled: false,
      createModel: () => mockTextModel(['ok'])
    })
    expect((await postImChat(h.port, { messages: userTurn('hi') })).status).toBe(404)
  })
})

describe('POST /api/ai/im-chat — the im_chat run', () => {
  test("first turn: creates the origin='im' session, asserts 'im_chat', returns the session header, persists", async () => {
    const persisted: PersistTurnInput[] = []
    const modes: Array<AgentContextMode | undefined> = []
    const createImSession = vi.fn(() => 77)
    const h = await start({
      ...BASE_CFG,
      imFeishuEnabled: true,
      createImSession,
      createModel: () => mockTextModel(['你好', '，飞书']),
      buildTools: (_collector, _approvalMode, contextMode) => {
        modes.push(contextMode)
        return {}
      },
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await postImChat(h.port, { messages: userTurn('hi from feishu') })
    expect(res.status).toBe(200)
    // The FIRST turn's pre-created session id reaches the caller (PR-3 stores the mapping).
    expect(res.headers.get('x-mailagent-session-id')).toBe('77')
    expect(createImSession).toHaveBeenCalledTimes(1)
    const frames = await readSse(res)
    const text = frames
      .filter((f) => f.type === 'text-delta')
      .map((f) => String(f.delta))
      .join('')
    expect(text).toBe('你好，飞书')
    // The run was prepared under the SERVER-asserted im_chat mode (body never carried it).
    expect(modes).toEqual(['im_chat'])
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(persisted[0].sessionId).toBe(77)
  })

  test('a turn that carries sessionId does NOT create a session; the header echoes it', async () => {
    const createImSession = vi.fn(() => 99)
    const h = await start({
      ...BASE_CFG,
      imFeishuEnabled: true,
      createImSession,
      createModel: () => mockTextModel(['again'])
    })
    const res = await postImChat(h.port, { sessionId: 41, messages: userTurn('turn 2') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-mailagent-session-id')).toBe('41')
    await readSse(res)
    expect(createImSession).not.toHaveBeenCalled()
  })

  test('createImSession returning null degrades to an unsaved run (still streams, no header)', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...BASE_CFG,
      imFeishuEnabled: true,
      createImSession: () => null,
      createModel: () => mockTextModel(['ok']),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await postImChat(h.port, { messages: userTurn('hi') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-mailagent-session-id')).toBeNull()
    await readSse(res)
    // onFinish still runs; the lifecycle-side persistTurn skips a null session (here we only
    // assert the wire didn't crash and the turn reached persist with sessionId null).
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(persisted[0].sessionId).toBeNull()
  })

  test('per-session 409 fence (E_RUN_ACTIVE) guards im runs like manual ones', async () => {
    const activeRuns = new ActiveRunRegistry()
    const h = await start({
      ...BASE_CFG,
      imFeishuEnabled: true,
      createImSession: () => 5,
      createModel: () => mockTextModel(['x']),
      activeRuns,
      detachedRunsEnabled: true
    })
    // Occupy the session slot, then POST a second im turn for the same session.
    const token = activeRuns.register(41, new AbortController())
    expect(token).not.toBeNull()
    const res = await postImChat(h.port, { sessionId: 41, messages: userTurn('hi') })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: string }).error).toBe('E_RUN_ACTIVE')
  })
})
