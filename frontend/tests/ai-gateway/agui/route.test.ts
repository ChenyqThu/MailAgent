// chat-panel P4 Phase 05 — AG-UI mirror endpoint (POST /api/ai/agui/chat) SSE golden.
//
// Drives the real gateway (startAiGatewayServer) with a MockLanguageModelV3 (no provider call) and
// reads the AG-UI SSE back. Proves: flag-off → 404 (route not registered); flag-on basic
// conversation → RUN_STARTED → STATE_SNAPSHOT → TEXT_MESSAGE_* → RUN_FINISHED; the STATE_SNAPSHOT is
// redacted (no token); the SAME persistTurn dual-write fires; no key → typed 503 (no SSE).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { startAiGatewayServer, type AiGatewayHandle } from '../../../src/ai-gateway/server'
import type { AiGatewayConfig, PersistTurnInput } from '../../../src/ai-gateway/config'

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
        /* skip */
      }
    }
  }
  return frames
}

const BASE: AiGatewayConfig = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/agui/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body)
  })
}

const userTurn = (text: string) => [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]

describe('agui route — flag gating', () => {
  test('flag-off → POST /api/ai/agui/chat is not registered (404)', async () => {
    const h = await start({ ...BASE, createModel: () => mockTextModel(['x']) })
    const res = await post(h.port, { messages: userTurn('hi') })
    expect(res.status).toBe(404)
  })

  test('flag-on but no key → typed 503 (no SSE)', async () => {
    const h = await start({ ...BASE, apiKey: null, aguiMirrorEnabled: true })
    const res = await post(h.port, { messages: userTurn('hi') })
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('E_NO_LLM_KEY')
  })
})

describe('agui route — basic conversation SSE', () => {
  test('RUN_STARTED → STATE_SNAPSHOT → TEXT_MESSAGE_* → RUN_FINISHED', async () => {
    const h = await start({
      ...BASE,
      aguiMirrorEnabled: true,
      createModel: () => mockTextModel(['Hello', ', ', 'world']),
      buildTools: () => ({
        email_search: tool({
          description: 'search',
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ ok: true })
        })
      })
    })
    const res = await post(h.port, {
      threadId: 'th-test',
      sessionId: 7,
      anchor: { type: 'email', id: 51240 },
      messages: userTurn('hi'),
      options: { enabledSkills: ['triage'] }
    })
    expect(res.status).toBe(200)
    const frames = await readSse(res)

    expect(frames[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 'th-test' })
    expect(frames[0].runId).toMatch(/^run-/)

    const snap = frames[1]
    expect(snap.type).toBe('STATE_SNAPSHOT')
    const snapshot = snap.snapshot as Record<string, unknown>
    expect(snapshot.thread).toEqual({ sessionId: 7, anchorType: 'email', anchorId: 51240 })
    expect(snapshot.capabilities).toEqual({
      enabledTools: ['email_search'],
      enabledSkills: ['triage'],
      highRiskApprovalRequired: true
    })

    const text = frames
      .filter((f) => f.type === 'TEXT_MESSAGE_CONTENT')
      .map((f) => String(f.delta))
      .join('')
    expect(text).toBe('Hello, world')

    const last = frames.at(-1)!
    expect(last.type).toBe('RUN_FINISHED')
    expect((last.result as Record<string, unknown>).status).toBe('success')
    // exactly one terminal event.
    expect(frames.filter((f) => f.type === 'RUN_FINISHED' || f.type === 'RUN_ERROR')).toHaveLength(
      1
    )
  })

  test('STATE_SNAPSHOT redacts a token in the context blob', async () => {
    const h = await start({
      ...BASE,
      aguiMirrorEnabled: true,
      createModel: () => mockTextModel(['ok'])
    })
    const res = await post(h.port, {
      messages: userTurn('hi'),
      contextSnapshot: { secretToken: 'sk-zzz', note: 'keep' }
    })
    const frames = await readSse(res)
    const snapshot = frames.find((f) => f.type === 'STATE_SNAPSHOT')!.snapshot as Record<
      string,
      unknown
    >
    const ctx = snapshot.mailagentContext as Record<string, unknown>
    expect(ctx.secretToken).toBeUndefined()
    expect(ctx.note).toBe('keep')
    // no secret anywhere in the streamed bytes.
    const all = JSON.stringify(frames)
    expect(all).not.toMatch(/sk-zzz/)
  })

  test('the SAME persistTurn dual-write fires (mirror is a true mirror)', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...BASE,
      aguiMirrorEnabled: true,
      createModel: () => mockTextModel(['Done']),
      persistTurn: (t) => {
        persisted.push(t)
      }
    })
    const res = await post(h.port, { sessionId: 9, messages: userTurn('go') })
    await readSse(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(persisted[0].sessionId).toBe(9)
    expect(persisted[0].responseMessage.role).toBe('assistant')
  })
})
