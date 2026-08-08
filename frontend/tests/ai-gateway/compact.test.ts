import { describe, expect, test, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { ChatMessage } from '../../src/shared/chat_model'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import {
  COMPACT_MAX_OUTPUT_TOKENS,
  COMPACT_SUMMARY_SECTIONS,
  chooseCompactBoundary,
  runManualCompact,
  serializeCompactTranscript
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
  test('not_needed when the estimated history is within target', () => {
    expect(chooseCompactBoundary([row(1, 'user', 'short')])).toBeNull()
  })

  test('boundary always starts the kept tail on a user message', () => {
    const boundary = chooseCompactBoundary(longRows)
    expect(boundary).not.toBeNull()
    expect(longRows[boundary!.firstKeptIndex].role).toBe('user')
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
})
