// S3 W1 — headless agentic search on the gateway: POST /api/ai/search-agent + the
// runHeadlessSearchAgent loop. Pure-Node: a stateful MockLanguageModelV3 is injected via
// cfg.createModel (generateText → doGenerate, one call per loop step) and cfg.buildTools
// returns plain ai `tool()`s, so the loop runs WITHOUT a provider or serve-api. Asserts the
// legacy runSearchAgent contract survived the re-home: candidate pool ∩ present_results
// (anti-hallucination), mailbox hard filter, best-effort on a non-compliant model, typed
// error codes, the SSE phase→result envelope, and the defensive read-tool whitelist.

import { afterEach, describe, expect, test } from 'vitest'
import { tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import {
  pickSearchAgentTools,
  runHeadlessSearchAgent,
  SEARCH_AGENT_MAX_ITER
} from '../../src/ai-gateway/searchAgentRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'

const handles: AiGatewayHandle[] = []
async function withServer(
  cfg: Partial<AiGatewayConfig>,
  run: (base: string) => Promise<void>
): Promise<void> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    ...cfg
  })
  handles.push(handle)
  await run(`http://127.0.0.1:${handle.port}`)
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

const USAGE = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }

interface GenStep {
  content: Array<Record<string, unknown>>
  finishReason: 'stop' | 'tool-calls'
}

/** Stateful model: call N returns steps[N] (last one repeats). Captures each call's
 *  tool list so the defensive-whitelist test can read what the model was shown. */
function mockStepModel(steps: GenStep[], seenToolNames?: string[][]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (seenToolNames) {
        const names = (opts.tools ?? []).map((t) => (t as { name: string }).name).sort()
        seenToolNames.push(names)
      }
      const step = steps[Math.min(call, steps.length - 1)]
      call++
      return {
        content: step.content as never,
        finishReason: step.finishReason,
        usage: USAGE,
        warnings: []
      }
    }
  })
}

const toolCall = (id: string, name: string, input: unknown): Record<string, unknown> => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input)
})

/** Hits the mock search tool returns (SearchHit-shaped; only the fields the loop reads). */
const HIT_A = { internal_id: 11, subject: 'A', sender: 'a@x.test', rank: 1, mailbox: '收件箱' }
const HIT_B = { internal_id: 22, subject: 'B', sender: 'b@x.test', rank: 2, mailbox: '收件箱' }
const HIT_C = { internal_id: 33, subject: 'C', sender: 'c@x.test', rank: 3, mailbox: '存档' }

/** A minimal buildTools factory: the fulltext read tool (returning `items`) + a write tool
 *  that must NEVER reach the loop (defensive whitelist). */
function mockBuildTools(opts?: { searchThrows?: boolean }): () => ToolSet {
  return () => ({
    email_search_fulltext: tool({
      description: 'mock fulltext',
      inputSchema: z.object({ query: z.string() }),
      execute: async () => {
        if (opts?.searchThrows) throw new Error('fts exploded')
        return { items: [HIT_A, HIT_B, HIT_C], total_matches: 3, has_more: false }
      }
    }),
    email_flag: tool({
      description: 'mock write tool — must be filtered out',
      inputSchema: z.object({ internal_id: z.number() }),
      execute: async () => ({ ok: true })
    })
  })
}

/** Read the endpoint's SSE frames into parsed events. */
async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.replace(/^data: /, '').trim()
      if (!line) continue
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* skip keepalive */
      }
    }
  }
  return events
}

const postSearch = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/ai/search-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body)
  })

describe('/api/ai/search-agent — happy path (search → present_results)', () => {
  test('streams phase events then a structured result: pool ∩ matched ids, ordered', async () => {
    const model = mockStepModel([
      { content: [toolCall('t1', 'email_search_fulltext', { query: 'redis' })], finishReason: 'tool-calls' },
      {
        content: [
          toolCall('t2', 'present_results', {
            // 99 is NOT in the pool → anti-hallucination drops it; order follows matched ids.
            matched_internal_ids: [22, 99, 11],
            summary: '找到两封相关邮件'
          })
        ],
        finishReason: 'tool-calls'
      }
    ])
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools() },
      async (base) => {
        const res = await postSearch(base, { userContent: '找 redis 相关邮件' })
        expect(res.status).toBe(200)
        const events = await readEvents(res)
        const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase)
        expect(phases).toEqual(['searching', 'summarizing'])
        const result = events.find((e) => e.type === 'result')?.result as {
          ok: boolean
          hits: Array<{ internal_id: number }>
          summary: string | null
        }
        expect(result.ok).toBe(true)
        expect(result.hits.map((h) => h.internal_id)).toEqual([22, 11])
        expect(result.summary).toBe('找到两封相关邮件')
      }
    )
  })

  test('mailbox hard filter drops cross-mailbox hits from the final result', async () => {
    const model = mockStepModel([
      { content: [toolCall('t1', 'email_search_fulltext', { query: 'q' })], finishReason: 'tool-calls' },
      {
        content: [
          toolCall('t2', 'present_results', {
            matched_internal_ids: [11, 33],
            summary: 'both mailboxes'
          })
        ],
        finishReason: 'tool-calls'
      }
    ])
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools() },
      async (base) => {
        const res = await postSearch(base, { userContent: 'q', mailbox: '存档' })
        const events = await readEvents(res)
        const result = events.find((e) => e.type === 'result')?.result as {
          ok: boolean
          hits: Array<{ internal_id: number }>
        }
        expect(result.ok).toBe(true)
        expect(result.hits.map((h) => h.internal_id)).toEqual([33])
      }
    )
  })

  test('defensive whitelist: the model only ever sees the 4 read tools + present_results', async () => {
    const seen: string[][] = []
    const model = mockStepModel(
      [{ content: [{ type: 'text', text: 'no tools needed' }], finishReason: 'stop' }],
      seen
    )
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools() },
      async (base) => {
        const res = await postSearch(base, { userContent: 'q' })
        await readEvents(res)
        expect(seen.length).toBeGreaterThan(0)
        // email_flag (write) was in the factory output but must not reach the loop.
        expect(seen[0]).toEqual(['email_search_fulltext', 'present_results'])
      }
    )
  })
})

describe('/api/ai/search-agent — non-compliant / empty / error paths', () => {
  test('best-effort: pooled hits without present_results → ok:true, summary null', async () => {
    const model = mockStepModel([
      { content: [toolCall('t1', 'email_search_fulltext', { query: 'q' })], finishReason: 'tool-calls' },
      { content: [{ type: 'text', text: 'done without presenting' }], finishReason: 'stop' }
    ])
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools() },
      async (base) => {
        const res = await postSearch(base, { userContent: 'q' })
        const events = await readEvents(res)
        const result = events.find((e) => e.type === 'result')?.result as {
          ok: boolean
          hits: Array<{ internal_id: number }>
          summary: string | null
        }
        expect(result.ok).toBe(true)
        expect(result.hits.map((h) => h.internal_id)).toEqual([11, 22, 33])
        expect(result.summary).toBeNull()
      }
    )
  })

  test('empty-handed (no tool call at all) → ok:false E_NO_OUTPUT', async () => {
    const model = mockStepModel([
      { content: [{ type: 'text', text: 'nothing to search' }], finishReason: 'stop' }
    ])
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools() },
      async (base) => {
        const res = await postSearch(base, { userContent: 'q' })
        const events = await readEvents(res)
        const result = events.find((e) => e.type === 'result')?.result as {
          ok: boolean
          error?: { code: string }
        }
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe('E_NO_OUTPUT')
      }
    )
  })

  test('tool execute failure does not crash the endpoint → structured empty result', async () => {
    const model = mockStepModel([
      { content: [toolCall('t1', 'email_search_fulltext', { query: 'q' })], finishReason: 'tool-calls' },
      { content: [{ type: 'text', text: 'the tool errored, giving up' }], finishReason: 'stop' }
    ])
    await withServer(
      { createModel: () => model, buildTools: mockBuildTools({ searchThrows: true }) },
      async (base) => {
        const res = await postSearch(base, { userContent: 'q' })
        expect(res.status).toBe(200)
        const events = await readEvents(res)
        const result = events.find((e) => e.type === 'result')?.result as {
          ok: boolean
          hits: unknown[]
          error?: { code: string }
        }
        expect(result.ok).toBe(false)
        expect(result.hits).toEqual([])
        expect(result.error?.code).toBeTruthy()
      }
    )
  })

  test('budget exhaustion (max iter, never presents) → E_MAX_ITER', async () => {
    // Every step calls the search tool and never present_results → stepCountIs stops it.
    const model = mockStepModel([
      { content: [toolCall('t1', 'email_search_fulltext', { query: 'q' })], finishReason: 'tool-calls' }
    ])
    // Search returns NO items so best-effort can't kick in (pool stays empty).
    const emptySearchTools = (): ToolSet => ({
      email_search_fulltext: tool({
        description: 'mock fulltext',
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ items: [], total_matches: 0, has_more: false })
      })
    })
    const result = await runHeadlessSearchAgent(
      {
        port: 0,
        baseUrl: 'http://127.0.0.1:0',
        apiKey: 'test',
        model: 'test-model',
        createModel: () => model,
        buildTools: emptySearchTools
      },
      { userContent: 'q' },
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('E_MAX_ITER')
  })

  test('abort (client cancelled) → E_ABORTED, no best-effort', async () => {
    const ac = new AbortController()
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        ac.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
    })
    const result = await runHeadlessSearchAgent(
      {
        port: 0,
        baseUrl: 'http://127.0.0.1:0',
        apiKey: 'test',
        model: 'test-model',
        createModel: () => model,
        buildTools: mockBuildTools()
      },
      { userContent: 'q' },
      ac.signal
    )
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('E_ABORTED')
  })

  test('upstream failure AFTER a pooled search → best-effort hits survive (legacy f-ter)', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            content: [toolCall('t1', 'email_search_fulltext', { query: 'q' })] as never,
            finishReason: 'tool-calls' as const,
            usage: USAGE,
            warnings: []
          }
        }
        throw new Error('upstream 500')
      }
    })
    const result = await runHeadlessSearchAgent(
      {
        port: 0,
        baseUrl: 'http://127.0.0.1:0',
        apiKey: 'test',
        model: 'test-model',
        createModel: () => model,
        buildTools: mockBuildTools()
      },
      { userContent: 'q' },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.hits.map((h) => h.internal_id)).toEqual([11, 22, 33])
    expect(result.summary).toBeNull()
  })
})

describe('/api/ai/search-agent — typed HTTP errors', () => {
  test('missing key → 503 E_NO_LLM_KEY', async () => {
    await withServer({ apiKey: null }, async (base) => {
      const res = await postSearch(base, { userContent: 'q' })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('E_NO_LLM_KEY')
    })
  })

  test('empty userContent → 400 E_INVALID_ARG', async () => {
    await withServer({}, async (base) => {
      const res = await postSearch(base, { userContent: '' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('E_INVALID_ARG')
    })
  })
})

describe('maxOutputTokens wiring (harness-chat lane C, owner 64k discipline)', () => {
  test('generateText receives an EXPLICIT maxOutputTokens (64k fallback on the test-mock branch)', async () => {
    // Mirrors length_finish_warning.test.ts's chat-loop pin: the test-mock resolveModelFactory
    // branch never sets resolvedModel.maxOutputTokens, so `?? 64_000` is what must reach the model.
    const seenMaxOutputTokens: Array<number | undefined> = []
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seenMaxOutputTokens.push(opts.maxOutputTokens)
        return {
          content: [
            toolCall('t1', 'present_results', { matched_internal_ids: [], summary: 's' })
          ] as never,
          finishReason: 'tool-calls' as const,
          usage: USAGE,
          warnings: []
        }
      }
    })
    await runHeadlessSearchAgent(
      {
        port: 0,
        baseUrl: 'http://127.0.0.1:0',
        apiKey: 'test',
        model: 'test-model',
        createModel: () => model,
        buildTools: mockBuildTools()
      },
      { userContent: 'q' },
      new AbortController().signal
    )
    expect(seenMaxOutputTokens).toEqual([64_000])
  })
})

describe('pickSearchAgentTools', () => {
  test('narrows to the whitelist whatever the factory returns', () => {
    const all = mockBuildTools()()
    const picked = pickSearchAgentTools(all)
    expect(Object.keys(picked)).toEqual(['email_search_fulltext'])
  })

  test('max-iter constant matches the legacy budget', () => {
    expect(SEARCH_AGENT_MAX_ITER).toBe(6)
  })
})
