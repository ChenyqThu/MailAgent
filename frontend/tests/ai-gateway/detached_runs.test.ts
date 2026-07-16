// harness-chat lane A B1 (task 07-15) — detach-tolerant chat runs (MAILAGENT_CHAT_DETACHED_RUNS).
//
// Pins the four B1 contracts against the real gateway (MockLanguageModelV3, no provider call):
//   1. FLAG ON: a client disconnect mid-stream does NOT abort the run — the server-side drain
//      completes and persistTurn fires exactly once with the full turn.
//   2. FLAG OFF (baseline fixation, research §3.1 step-0): the legacy close→abort wiring — a client
//      disconnect aborts the upstream call and NOTHING persists (onFinish isAborted skips). This is
//      the pre-B1 gateway truth the emergency rollback returns to.
//   3. Explicit stop channel: POST /api/ai/run/stop aborts the run (nothing persists) and frees the
//      session; GET /api/ai/run/active reports the live truth (active during, 404 after).
//   4. Same-session concurrency: a second POST /api/ai/chat while a run is active → 409 E_RUN_ACTIVE
//      (a different session is unaffected).
// Plus ActiveRunRegistry unit coverage (atomic gate / runId-matched release / stale takeover).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import { ActiveRunRegistry, STALE_RUN_MS } from '../../src/ai-gateway/activeRuns'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** A v3 model that streams `parts` as text-delta chunks with a per-chunk delay (so a test can
 *  disconnect / probe / stop mid-stream deterministically). */
function slowTextModel(parts: string[], chunkDelayInMs: number): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
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

function baseCfg(opts: {
  model: MockLanguageModelV3
  persisted: PersistTurnInput[]
  detached: boolean
  registry?: ActiveRunRegistry
}): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => opts.model,
    persistTurn: (t) => {
      opts.persisted.push(t)
    },
    ...(opts.detached
      ? { detachedRunsEnabled: true, activeRuns: opts.registry ?? new ActiveRunRegistry() }
      : {})
  }
}

function chatBody(sessionId: number): string {
  return JSON.stringify({
    sessionId,
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }]
  })
}

function postChat(port: number, sessionId: number, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: chatBody(sessionId),
    ...(signal ? { signal } : {})
  })
}

function runActive(port: number, sessionId: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/run/active?sessionId=${sessionId}`)
}

function runStop(port: number, sessionId: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/run/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })
}

/** Read `frames` SSE frames from a streaming response, then abort the fetch (client disconnect). */
async function readSomeThenAbort(
  res: Response,
  ac: AbortController,
  frames: number
): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = 0
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      seen += parts.length
      if (seen >= frames) {
        ac.abort()
        return
      }
    }
  } catch {
    /* abort surfaces as a read error — expected */
  }
}

/** Drain a streaming response to completion, returning the concatenated text-delta payload. */
async function drainText(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
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
        const f = JSON.parse(line) as { type?: string; delta?: string }
        if (f.type === 'text-delta' && typeof f.delta === 'string') text += f.delta
      } catch {
        /* keepalive */
      }
    }
  }
  return text
}

describe('B1 — detached runs (flag ON): client disconnect never loses the turn', () => {
  test('disconnect mid-stream → the drain completes and persistTurn fires exactly once (full text)', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(
      baseCfg({
        model: slowTextModel(['一', '二', '三', '四', '五'], 30),
        persisted,
        detached: true
      })
    )
    const ac = new AbortController()
    const res = await postChat(h.port, 11, ac.signal)
    expect(res.status).toBe(200)
    await readSomeThenAbort(res, ac, 2) // client gone after ~2 frames of a 5-delta stream

    // The gateway drains server-side to onFinish → persistTurn with the FULL assistant text.
    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    const turn = persisted[0]
    expect(turn.sessionId).toBe(11)
    const text = turn.responseMessage.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
    expect(text).toBe('一二三四五')
    // …and never a second persist (exactly once).
    await new Promise((r) => setTimeout(r, 150))
    expect(persisted).toHaveLength(1)
  })

  test('the session frees after completion: /run/active flips active→404', async () => {
    const persisted: PersistTurnInput[] = []
    const registry = new ActiveRunRegistry()
    const h = await start(
      baseCfg({ model: slowTextModel(['a', 'b', 'c'], 40), persisted, detached: true, registry })
    )
    const res = await postChat(h.port, 12)
    // wire parity with ai@7's pipeUIMessageStreamToResponse: the manual drain must send the same
    // UI_MESSAGE_STREAM_HEADERS (the ai@6 renderer client keys off the stream marker header).
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    // headers arrived → the run is registered; the stream is still delaying chunks.
    const during = await runActive(h.port, 12)
    expect(during.status).toBe(200)
    expect(((await during.json()) as { active: boolean }).active).toBe(true)

    await drainText(res)
    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    const after = await runActive(h.port, 12)
    expect(after.status).toBe(404)
    expect(((await after.json()) as { active: boolean }).active).toBe(false)
    expect(registry.size()).toBe(0)
  })
})

describe('B1 — flag OFF baseline (research §3.1 step-0 fixation): close → abort → turn LOST', () => {
  test('disconnect mid-stream aborts the upstream run; persistTurn never fires', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(
      baseCfg({
        model: slowTextModel(['一', '二', '三', '四', '五'], 30),
        persisted,
        detached: false
      })
    )
    const ac = new AbortController()
    const res = await postChat(h.port, 21, ac.signal)
    await readSomeThenAbort(res, ac, 2)
    // Give the (aborted) run ample time — nothing may persist (onFinish isAborted skips).
    await new Promise((r) => setTimeout(r, 400))
    expect(persisted).toHaveLength(0)
  })

  test('run endpoints are unwired: /run/active → 404 {active:false}, /run/stop → 404 E_NOT_IMPLEMENTED', async () => {
    const h = await start(
      baseCfg({ model: slowTextModel(['x'], 5), persisted: [], detached: false })
    )
    const active = await runActive(h.port, 1)
    expect(active.status).toBe(404)
    expect(((await active.json()) as { active: boolean }).active).toBe(false)
    const stop = await runStop(h.port, 1)
    expect(stop.status).toBe(404)
    expect(((await stop.json()) as { error: string }).error).toBe('E_NOT_IMPLEMENTED')
  })
})

describe('B1 — explicit stop channel (POST /api/ai/run/stop)', () => {
  test('stop mid-stream aborts the run: nothing persists, session freed, stream ends', async () => {
    const persisted: PersistTurnInput[] = []
    const registry = new ActiveRunRegistry()
    const h = await start(
      baseCfg({
        model: slowTextModel(['一', '二', '三', '四', '五', '六', '七', '八'], 60),
        persisted,
        detached: true,
        registry
      })
    )
    const res = await postChat(h.port, 31)
    const stop = await runStop(h.port, 31)
    expect(stop.status).toBe(200)
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true)
    // The registry freed the session immediately (a fresh turn may start).
    expect(registry.hasActive(31)).toBe(false)
    // The (aborted) stream closes; the aborted turn never persists.
    await drainText(res).catch(() => '')
    await new Promise((r) => setTimeout(r, 300))
    expect(persisted).toHaveLength(0)
  })

  test('stop with nothing running → { stopped:false }; bad args → 400', async () => {
    const h = await start(
      baseCfg({ model: slowTextModel(['x'], 5), persisted: [], detached: true })
    )
    const stop = await runStop(h.port, 99)
    expect(stop.status).toBe(200)
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(false)
    const bad = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(bad.status).toBe(400)
  })
})

describe('B1 — same-session concurrency gate (409 E_RUN_ACTIVE)', () => {
  test('a second POST for the SAME session while streaming → 409; a DIFFERENT session streams fine', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(
      baseCfg({
        model: slowTextModel(['一', '二', '三', '四', '五'], 80),
        persisted,
        detached: true
      })
    )
    const res1 = await postChat(h.port, 33)
    expect(res1.status).toBe(200)

    const res2 = await postChat(h.port, 33)
    expect(res2.status).toBe(409)
    expect(((await res2.json()) as { error: string }).error).toBe('E_RUN_ACTIVE')

    const res3 = await postChat(h.port, 34)
    expect(res3.status).toBe(200)

    await Promise.all([drainText(res1), drainText(res3)])
    await vi.waitFor(() => expect(persisted).toHaveLength(2), { timeout: 3000 })
    expect(persisted.map((t) => t.sessionId).sort()).toEqual([33, 34])
  })
})

describe('ActiveRunRegistry — unit', () => {
  test('register is the atomic gate: second register for a live session → null', () => {
    const reg = new ActiveRunRegistry()
    const a = reg.register(1, new AbortController())
    expect(a).not.toBeNull()
    expect(reg.register(1, new AbortController())).toBeNull()
    expect(reg.getActive(1)?.runId).toBe(a!.runId)
  })

  test('release is runId-matched: a stale release cannot evict a newer run', () => {
    const reg = new ActiveRunRegistry()
    const a = reg.register(1, new AbortController())!
    reg.stop(1) // explicit stop frees the slot
    const b = reg.register(1, new AbortController())!
    reg.release(1, a.runId) // the OLD run's finally — must be a no-op
    expect(reg.getActive(1)?.runId).toBe(b.runId)
    reg.release(1, b.runId)
    expect(reg.getActive(1)).toBeNull()
  })

  test('stop aborts the controller and frees the session immediately', () => {
    const reg = new ActiveRunRegistry()
    const ctl = new AbortController()
    reg.register(5, ctl)
    const out = reg.stop(5)
    expect(out.stopped).toBe(true)
    expect(ctl.signal.aborted).toBe(true)
    expect(reg.hasActive(5)).toBe(false)
    expect(reg.stop(5).stopped).toBe(false)
  })

  test('a stale (wedged) entry never blocks the session: hasActive false + register takes over', () => {
    let now = 1_000_000
    const reg = new ActiveRunRegistry({ now: () => now })
    const oldCtl = new AbortController()
    reg.register(7, oldCtl)
    now += STALE_RUN_MS + 1
    expect(reg.hasActive(7)).toBe(false)
    const b = reg.register(7, new AbortController())
    expect(b).not.toBeNull()
    expect(oldCtl.signal.aborted).toBe(true) // the wedged run was defensively aborted
  })
})
