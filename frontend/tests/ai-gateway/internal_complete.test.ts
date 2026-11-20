// Phase 4 WP-4C — POST /api/ai/internal/complete unit & server tests.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, GatewayUsageEvent } from '../../src/ai-gateway/config'

const LOCAL_TOKEN = 'test-internal-local-token-123'
const handles: AiGatewayHandle[] = []

async function withServer(
  cfg: Partial<AiGatewayConfig>,
  run: (base: string) => Promise<void>
): Promise<void> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    localApiToken: LOCAL_TOKEN,
    ...cfg
  })
  handles.push(handle)
  await run(`http://127.0.0.1:${handle.port}`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (handles.length > 0) {
    await handles.pop()!.close()
  }
})

describe('POST /api/ai/internal/complete', () => {
  test('rejects missing or mismatched X-MailAgent-Local-Token with 401 E_UNAUTHORIZED', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 }
        },
        warnings: []
      })
    })
    await withServer({ createModel: () => model }, async (base) => {
      const noHeader = await fetch(`${base}/api/ai/internal/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      expect(noHeader.status).toBe(401)
      const noBody = (await noHeader.json()) as { ok: boolean; error: { code: string } }
      expect(noBody.ok).toBe(false)
      expect(noBody.error.code).toBe('E_UNAUTHORIZED')

      const badHeader = await fetch(`${base}/api/ai/internal/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MailAgent-Local-Token': 'wrong-token'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      expect(badHeader.status).toBe(401)
    })
  })

  test('returns single-step jsonSchema toolCalls + 4-tier usage + costUsd without executing tools', async () => {
    const recorded: GatewayUsageEvent[] = []
    let capturedPromptCount = 0
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        capturedPromptCount = opts.prompt.length
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tc_1',
              toolName: 'classify_email',
              input: JSON.stringify({ category: 'work', priority: 'high' })
            }
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
            outputTokens: { total: 50, text: 50, reasoning: 0 }
          },
          warnings: []
        }
      }
    })

    await withServer(
      {
        createModel: () => model,
        recordUsageEvent: (evt) => recorded.push(evt)
      },
      async (base) => {
        const res = await fetch(`${base}/api/ai/internal/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MailAgent-Local-Token': LOCAL_TOKEN
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            systemBlocks: [{ text: 'System prompt', cacheControl: true }],
            messages: [{ role: 'user', content: 'Classify this email' }],
            tools: [
              {
                name: 'classify_email',
                description: 'Classify email metadata',
                inputSchema: {
                  type: 'object',
                  properties: {
                    category: { type: 'string' },
                    priority: { type: 'string' }
                  },
                  required: ['category', 'priority']
                }
              }
            ],
            toolChoice: { type: 'tool', toolName: 'classify_email' },
            surface: 'memory_capture',
            recordUsage: false
          })
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          ok: boolean
          model: string
          toolCalls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>
          finishReason: string
          usage: {
            inputTokens: number
            outputTokens: number
            cacheReadTokens: number
            cacheWriteTokens: number
            noCacheTokens: number | null
          }
          costUsd: number | null
        }
        expect(body.ok).toBe(true)
        expect(body.model).toBe('claude-sonnet-4-6')
        expect(capturedPromptCount).toBe(2) // system + user
        expect(body.toolCalls).toEqual([
          {
            toolCallId: 'tc_1',
            toolName: 'classify_email',
            input: { category: 'work', priority: 'high' }
          }
        ])
        expect(body.finishReason).toBe('tool-calls')
        expect(body.usage).toEqual({
          inputTokens: 1000,
          outputTokens: 50,
          cacheReadTokens: 700,
          cacheWriteTokens: 100,
          noCacheTokens: 200
        })
        expect(body.costUsd).not.toBeNull()
        expect(body.costUsd!).toBeGreaterThan(0)
        // recordUsage=false must NOT write duplicate auxiliary log rows
        expect(recorded).toHaveLength(0)
      }
    )
  })

  test('supports multi-turn assistant toolCalls + tool results and recordUsage: true', async () => {
    const recorded: GatewayUsageEvent[] = []
    let seenRoles: string[] = []
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seenRoles = opts.prompt.map((m) => m.role)
        return {
          content: [{ type: 'text', text: 'Done synthesizing.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 400, noCache: 400, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 40, text: 40, reasoning: 0 }
          },
          warnings: []
        }
      }
    })

    await withServer(
      {
        createModel: () => model,
        recordUsageEvent: (evt) => recorded.push(evt)
      },
      async (base) => {
        const res = await fetch(`${base}/api/ai/internal/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MailAgent-Local-Token': LOCAL_TOKEN
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
              { role: 'user', content: 'Check inbox' },
              {
                role: 'assistant',
                content: '',
                toolCalls: [{ toolCallId: 'c1', toolName: 'search', input: { q: 'invoice' } }]
              },
              {
                role: 'tool',
                results: [{ toolCallId: 'c1', toolName: 'search', output: '{"count":2}' }]
              }
            ],
            surface: 'task_extract',
            recordUsage: true
          })
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean; text: string }
        expect(body.ok).toBe(true)
        expect(body.text).toBe('Done synthesizing.')
        expect(seenRoles).toEqual(['user', 'assistant', 'tool'])
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({
          surface: 'task_extract',
          model: 'claude-sonnet-4-6',
          inputTokens: 400,
          outputTokens: 40,
          status: 'ok'
        })
      }
    )
  })

  test('maps RetryError wrapping 429 APICallError to 429 E_QUOTA with sanitized message', async () => {
    const inner429 = new APICallError({
      message: 'rate limit Authorization: Bearer sk-secret-xyz',
      url: 'https://relay.example/v1/messages',
      requestBodyValues: {},
      statusCode: 429
    })
    const retryErr = new RetryError({
      message: 'Failed after 3 attempts: Authorization: Bearer sk-secret-xyz',
      reason: 'maxRetriesExceeded',
      errors: [inner429]
    })
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw retryErr
      }
    })

    await withServer({ createModel: () => model }, async (base) => {
      const res = await fetch(`${base}/api/ai/internal/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MailAgent-Local-Token': LOCAL_TOKEN
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      expect(res.status).toBe(429)
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('E_QUOTA')
      expect(body.error.message).toBe('HTTP 429 AI_APICallError')
      expect(body.error.message).not.toContain('sk-secret-xyz')
    })
  })
})
