// S3 W1 — runGatewaySearchAgent (the renderer client of POST /api/ai/search-agent).
//
// End-to-end against a REAL gateway server (mock model + mock buildTools) so the SSE
// encode/decode of both sides is covered by one test: the client resolves the gateway
// base URL from ?aiGatewayPort= (window stub), reads the search-agent config row
// (mock reads), assembles the prompt+query user content, consumes phase events, and
// runs the nlToDsl fallback when the agent comes back empty — the legacy
// chat.runSearchAgent contract, unchanged.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { APICallError, tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { startAiGatewayServer, type AiGatewayHandle } from '../../../src/ai-gateway/server'
import {
  DEFAULT_SEARCH_AGENT_PROMPT,
  runGatewaySearchAgent
} from '../../../src/shared/assistant/searchAgentClient'
import type { MailApi, SearchAgentPhase } from '../../../src/shared/api/types'

const handles: AiGatewayHandle[] = []
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
  vi.unstubAllGlobals()
})

const USAGE = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
const HIT = { internal_id: 7, subject: 'Hit', sender: 's@x.test', rank: 1, mailbox: '收件箱' }

/** Minimal reads surface the client touches (report config / settings / nlToDsl). */
function mockReads(opts?: {
  agentRow?: Record<string, unknown> | null
  getConfigThrows?: boolean
  nlToDsl?: { dsl: string; error?: string }
}): MailApi {
  return {
    report: {
      getConfig: async () => {
        if (opts?.getConfigThrows) throw new Error('config unavailable')
        return opts?.agentRow ? [opts.agentRow] : []
      }
    },
    settings: {
      get: async () => ({ userEmail: 'me@x.test' })
    },
    email: {
      nlToDsl: async () => opts?.nlToDsl ?? { dsl: '', error: 'E_EMPTY' }
    }
  } as unknown as MailApi
}

/** Start a real gateway whose model presents HIT (or goes empty), capturing the model
 *  prompt so the client-assembled userContent is assertable. Stubs window so
 *  resolveAiGatewayBaseUrl finds the port. */
async function startGateway(opts: {
  present?: boolean
  hang?: boolean
  prompts?: unknown[]
}): Promise<void> {
  let call = 0
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt, abortSignal }) => {
      opts.prompts?.push(prompt)
      if (opts.hang) {
        await new Promise((_, reject) => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          if (abortSignal?.aborted) reject(err)
          abortSignal?.addEventListener('abort', () => reject(err), { once: true })
        })
      }
      call++
      if (!opts.present) {
        return {
          content: [{ type: 'text', text: 'nothing found' }] as never,
          finishReason: 'stop' as const,
          usage: USAGE,
          warnings: []
        }
      }
      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'email_search_fulltext',
              input: JSON.stringify({ query: 'q' })
            }
          ] as never,
          finishReason: 'tool-calls' as const,
          usage: USAGE,
          warnings: []
        }
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 't2',
            toolName: 'present_results',
            input: JSON.stringify({ matched_internal_ids: [7], summary: 'one hit' })
          }
        ] as never,
        finishReason: 'tool-calls' as const,
        usage: USAGE,
        warnings: []
      }
    }
  })
  const buildTools = (): ToolSet => ({
    email_search_fulltext: tool({
      description: 'mock',
      inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ items: [HIT], total_matches: 1, has_more: false })
    })
  })
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    createModel: () => model,
    buildTools
  })
  handles.push(handle)
  vi.stubGlobal('window', { location: { search: `?aiGatewayPort=${handle.port}` } })
}

/** Start a real gateway whose model throws on the very first `doGenerate` call — before
 *  any tool use, so the candidate pool stays empty and searchAgentRun's normalizeLoopError
 *  mapping surfaces instead of a best-effort result. `isRetryable: false` so the AI SDK's
 *  default retry wrapper (retryable APICallError → exponential backoff) doesn't retry and
 *  re-wrap the error before it reaches normalizeLoopError. */
async function startGatewayThatThrows(statusCode?: number): Promise<void> {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new APICallError({
        message: `upstream failure${statusCode ? ` ${statusCode}` : ''}`,
        url: 'https://example.test/v1/messages',
        requestBodyValues: {},
        statusCode,
        isRetryable: false
      })
    }
  })
  const buildTools = (): ToolSet => ({})
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    createModel: () => model,
    buildTools
  })
  handles.push(handle)
  vi.stubGlobal('window', { location: { search: `?aiGatewayPort=${handle.port}` } })
}

describe('runGatewaySearchAgent', () => {
  test('no gateway base URL (desktop w/o port, node baseline) → E_UNSUPPORTED, no fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await runGatewaySearchAgent(mockReads(), { query: 'hello' })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_UNSUPPORTED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('end-to-end: phases stream, hits land, custom config row drives prompt + model', async () => {
    const prompts: unknown[] = []
    await startGateway({ present: true, prompts })
    const phases: SearchAgentPhase[] = []
    const reads = mockReads({
      agentRow: {
        type: 'search',
        enabled: true,
        model: 'my-search-model',
        prompt: '自定义搜索指令 {today} {me}',
        prompt_is_default: false
      }
    })
    const res = await runGatewaySearchAgent(reads, {
      query: '找 redis 邮件',
      onPhase: (p) => phases.push(p)
    })
    expect(res.ok).toBe(true)
    expect(res.hits.map((h) => h.internal_id)).toEqual([7])
    expect(res.summary).toBe('one hit')
    expect(phases).toEqual(['searching', 'summarizing'])
    // The client assembled userContent = custom prompt (placeholders filled) + query.
    const first = JSON.stringify(prompts[0])
    expect(first).toContain('自定义搜索指令')
    expect(first).toContain('me@x.test')
    expect(first).toContain('找 redis 邮件')
    expect(first).not.toContain('{today}')
  })

  test('config read failure → falls back to the built-in default prompt, still succeeds', async () => {
    const prompts: unknown[] = []
    await startGateway({ present: true, prompts })
    const res = await runGatewaySearchAgent(mockReads({ getConfigThrows: true }), {
      query: 'anything'
    })
    expect(res.ok).toBe(true)
    const first = JSON.stringify(prompts[0])
    // The default prompt's opening line survives placeholder filling.
    expect(first).toContain(DEFAULT_SEARCH_AGENT_PROMPT.slice(0, 12))
  })

  test('agent empty-handed → nlToDsl fallback fills fallbackDsl, gateway code wins', async () => {
    await startGateway({ present: false })
    const res = await runGatewaySearchAgent(
      mockReads({ nlToDsl: { dsl: 'from:alice redis' } }),
      { query: 'alice 的 redis 邮件' }
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_NO_OUTPUT')
    expect(res.fallbackDsl).toBe('from:alice redis')
  })

  test('external abort mid-run → E_ABORTED, no fallback call', async () => {
    await startGateway({ present: true, hang: true })
    const nlToDslSpy = vi.fn()
    const reads = mockReads()
    ;(reads.email as unknown as Record<string, unknown>).nlToDsl = nlToDslSpy
    const ac = new AbortController()
    const p = runGatewaySearchAgent(reads, { query: 'q', signal: ac.signal })
    // Let the request reach the hanging model, then cancel.
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_ABORTED')
    expect(nlToDslSpy).not.toHaveBeenCalled()
  })

  test('mailbox is trimmed once and hard-filters the final hits', async () => {
    await startGateway({ present: true })
    const res = await runGatewaySearchAgent(mockReads(), {
      query: 'q',
      mailbox: ' 存档 '
    })
    // HIT lives in 收件箱; the trimmed 存档 filter drops it. present_results WAS seen,
    // so the run is ok:true with zero hits (legacy f-path semantics — the palette
    // renders the explicit empty state, not an error).
    expect(res.ok).toBe(true)
    expect(res.hits).toEqual([])
    expect(res.summary).toBe('one hit')
  })

  test('upstream 429 (APICallError) → E_QUOTA, gateway code wins over nlToDsl', async () => {
    await startGatewayThatThrows(429)
    const res = await runGatewaySearchAgent(
      mockReads({ nlToDsl: { dsl: 'from:alice redis' } }),
      { query: 'q' }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatchObject({ code: 'E_QUOTA' })
    expect(res.error?.message.length).toBeGreaterThan(0)
  })

  test('upstream 500 (APICallError, non-429 status) → E_UPSTREAM', async () => {
    await startGatewayThatThrows(500)
    const res = await runGatewaySearchAgent(mockReads(), { query: 'q' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatchObject({ code: 'E_UPSTREAM' })
    expect(res.error?.message.length).toBeGreaterThan(0)
  })

  test('upstream failure w/o a status code (network-style APICallError) → E_UPSTREAM too', async () => {
    await startGatewayThatThrows(undefined)
    const res = await runGatewaySearchAgent(mockReads(), { query: 'q' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatchObject({ code: 'E_UPSTREAM' })
  })
})
