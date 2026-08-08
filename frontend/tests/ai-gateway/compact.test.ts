import { describe, expect, test, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { ChatMessage } from '../../src/shared/chat_model'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import {
  COMPACT_MAX_OUTPUT_TOKENS,
  COMPACT_SUMMARY_SECTIONS,
  chunkCompactRows,
  chooseCompactBoundary,
  isContextOverflowError,
  runCompact,
  runManualCompact,
  serializeCompactTranscript,
  shouldAutoCompact,
  shouldRecoverContextOverflow
} from '../../src/ai-gateway/compact'

function row(id: number, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    session_id: 1,
    role,
    content,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    context_tokens: role === 'assistant' ? 91_000 : null,
    created_at: id,
    updated_at: id
  }
}

const longRows = [
  row(1, 'user', 'old request '.repeat(30_000)),
  row(2, 'assistant', 'old answer '.repeat(30_000)),
  row(3, 'user', 'tail request'),
  row(4, 'assistant', 'tail answer')
]

describe('manual compact service', () => {
  test('automatic threshold is exactly 90% and every frozen denial path is inert', () => {
    const base = {
      p3Enabled: true,
      settingEnabled: true,
      contextTokens: 90,
      contextWindow: 100,
      runActive: false,
      compactActive: false
    }
    expect(shouldAutoCompact({ ...base, contextTokens: 89.9 })).toBe(false)
    expect(shouldAutoCompact(base)).toBe(true)
    expect(shouldAutoCompact({ ...base, p3Enabled: false })).toBe(false)
    expect(shouldAutoCompact({ ...base, settingEnabled: false })).toBe(false)
    expect(shouldAutoCompact({ ...base, contextWindow: null })).toBe(false)
    expect(shouldAutoCompact({ ...base, runActive: true })).toBe(false)
    expect(shouldAutoCompact({ ...base, compactActive: true })).toBe(false)
  })

  test('provider overflow classifier is conservative and retry is allowed exactly once pre-byte', () => {
    const anthropic = {
      statusCode: 400,
      responseBody: JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens' }
      })
    }
    const openai = {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' }
      })
    }
    expect(isContextOverflowError(anthropic, 'anthropic')).toBe(true)
    expect(isContextOverflowError(openai, 'openai')).toBe(true)
    expect(isContextOverflowError(openai, 'openai-compatible')).toBe(true)
    expect(
      isContextOverflowError(new Error("This model's maximum context length is 128000 tokens"), 'openai-compatible')
    ).toBe(true)
    expect(isContextOverflowError(openai, 'google')).toBe(false)
    expect(isContextOverflowError(new Error('rate limit exceeded'), 'openai')).toBe(false)
    expect(
      shouldRecoverContextOverflow({
        attempt: 0,
        hasWrittenBytes: false,
        error: openai,
        protocol: 'openai'
      })
    ).toBe(true)
    expect(
      shouldRecoverContextOverflow({
        attempt: 1,
        hasWrittenBytes: false,
        error: openai,
        protocol: 'openai'
      })
    ).toBe(false)
    expect(
      shouldRecoverContextOverflow({
        attempt: 0,
        hasWrittenBytes: true,
        error: openai,
        protocol: 'openai'
      })
    ).toBe(false)
  })

  test('not_needed when the estimated history is within target', () => {
    expect(chooseCompactBoundary([row(1, 'user', 'short')])).toBeNull()
  })

  test('boundary always starts the kept tail on a user message', () => {
    const boundary = chooseCompactBoundary(longRows)
    expect(boundary).not.toBeNull()
    if (!boundary) throw new Error('expected compact boundary')
    expect(longRows[boundary.firstKeptIndex].role).toBe('user')
  })

  test('transcript includes canonical tool parts and clips oversized results', () => {
    const toolRow = {
      ...row(1, 'assistant', 'fallback'),
      ui_message_json: JSON.stringify({ parts: [{ type: 'tool-x', output: 'x'.repeat(20_000) }] })
    }
    const transcript = serializeCompactTranscript([toolRow])
    expect(transcript).toContain('tool-x')
    expect(transcript).toContain('[truncated]')
  })

  test('uses current model, no tools, effort none, <=8K output, and writes full A.6 metadata', async () => {
    let call: Record<string, unknown> | null = null
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        call = options as unknown as Record<string, unknown>
        return {
          content: [{ type: 'text', text: COMPACT_SUMMARY_SECTIONS.map((s) => `## ${s}\nok`).join('\n') }],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: []
        }
      }
    })
    const appendCompactMessage = vi.fn()
    const cfg = {
      port: 0,
      baseUrl: 'http://example.invalid',
      apiKey: 'test',
      model: 'fallback',
      createModel: () => model
    } as AiGatewayConfig
    const result = await runManualCompact(
      cfg,
      {
        listSessionMessages: () => longRows,
        getSessionModel: () => 'session-model',
        appendCompactMessage
      },
      1,
      new AbortController().signal
    )
    expect(result.status).toBe('completed')
    expect(call?.tools).toBeUndefined()
    expect(call?.maxOutputTokens).toBe(COMPACT_MAX_OUTPUT_TOKENS)
    expect(appendCompactMessage).toHaveBeenCalledTimes(1)
    const metadata = appendCompactMessage.mock.calls[0][0].metadata
    expect(metadata).toMatchObject({
      kind: 'compact',
      version: 1,
      compactedThroughMessageId: 2,
      firstKeptMessageId: 3,
      tokensBefore: 91_000,
      model: 'session-model',
      reason: 'manual',
      valid: true
    })
    expect(typeof metadata.estimatedTokensAfter).toBe('number')
    expect(typeof metadata.createdAt).toBe('number')
  })

  test('abort never writes a compact row', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        controller.abort()
        return {
          content: [{ type: 'text', text: 'summary' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: []
        }
      }
    })
    const appendCompactMessage = vi.fn()
    await expect(
      runManualCompact(
        { port: 0, baseUrl: '', apiKey: 'x', model: 'm', createModel: () => model },
        { listSessionMessages: () => longRows, getSessionModel: () => 'm', appendCompactMessage },
        1,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(appendCompactMessage).not.toHaveBeenCalled()
  })

  test('overflow splits old rows, summarizes every chunk, then merges all partials once', async () => {
    expect(chunkCompactRows(longRows.slice(0, 2), 1_000).length).toBeGreaterThan(1)
    const prompts: string[] = []
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt)
        prompts.push(prompt)
        const text =
          prompts.length === 1
            ? 'partial-A email #42'
            : prompts.length === 2
              ? 'partial-B rejected approval'
              : COMPACT_SUMMARY_SECTIONS.map((section) => `## ${section}\nmerged`).join('\n')
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: []
        }
      }
    })
    const appendCompactMessage = vi.fn()
    const result = await runCompact(
      { port: 0, baseUrl: '', apiKey: 'x', model: 'm', createModel: () => model },
      { listSessionMessages: () => longRows, getSessionModel: () => 'm', appendCompactMessage },
      1,
      new AbortController().signal,
      { reason: 'overflow', contextWindow: 1_000 }
    )
    expect(result.status).toBe('completed')
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('partial-A email #42')
    expect(prompts[2]).toContain('partial-B rejected approval')
    expect(appendCompactMessage.mock.calls[0][0].metadata.reason).toBe('overflow')
  })
})
