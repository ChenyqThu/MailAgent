// harness-chat lane C (07-15, PRD §3) — finishReason==='length' fail-loud + explicit
// maxOutputTokens wiring (owner discipline: every LLM call gets an explicit 64k output ceiling,
// see feedback_llm_call_settings memory / research lane-c-write-truncation.md §4/§6②).
//
// Pure-Node, mirrors chat_stream.test.ts's harness (real streamText through
// startAiGatewayServer + a MockLanguageModelV3 stub — no real provider call).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import { LENGTH_TRUNCATION_WARNING_TEXT } from '../../src/ai-gateway/chatRun'
import type { PersistTurnInput } from '../../src/ai-gateway/config'
import { extractTextFromUIMessage } from '../../src/shared/assistant/uiMessage'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}

const CHAT_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

function userTurn(text: string): unknown {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
}

// 🔴 LanguageModelV3's 'finish' stream part carries finishReason as `{ unified, raw? }` (NOT the
// v2-era bare string) — @ai-sdk/provider's LanguageModelV3FinishReason type. MockLanguageModelV3
// declares specificationVersion:'v3' so it's NEVER routed through the asLanguageModelV3 v2→v3
// compat shim that used to do this wrapping; a bare string here silently normalizes to 'other'
// deep inside streamText's step processing (confirmed against the installed ai@7.0.0 source —
// every OTHER finish-reason chunk in this test suite happens to use bare strings too, but no
// existing test actually asserts the resolved finishReason value, so this was a latent gap).
const LENGTH_FINISH = {
  type: 'finish' as const,
  finishReason: { unified: 'length' as const },
  usage: USAGE
}
const STOP_FINISH = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const },
  usage: USAGE
}

/** A model that finishes a PLAIN text reply with finishReason:'length' (no tool call). */
function mockLengthTruncatedTextModel(parts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end' as const, id: '1' },
          LENGTH_FINISH
        ]
      })
    })
  })
}

/** A model that calls a tool with a mid-JSON TRUNCATED input (invalid, unparseable) and then
 *  finishes with finishReason:'length' — the shape a real maxOutputTokens cutoff produces when
 *  the model is mid-way through streaming a tool call's input JSON. */
function mockLengthTruncatedToolCallModel(
  toolName: string,
  truncatedInputJson: string
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: 'Updating that for you' },
          { type: 'text-end' as const, id: '1' },
          { type: 'tool-call' as const, toolCallId: 'tc1', toolName, input: truncatedInputJson },
          LENGTH_FINISH
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
        /* skip non-json keepalive frames */
      }
    }
  }
  return frames
}

describe('finishReason=length — fail-loud warning + maxOutputTokens wiring', () => {
  test('plain text truncated (no tools): the PERSISTED turn carries the visible warning text', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockLengthTruncatedTextModel(['Here is a very long reply that got cu']),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('go on') })
    })
    await readSse(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    const text = extractTextFromUIMessage(persisted[0].responseMessage)
    expect(text).toContain('Here is a very long reply that got cu')
    expect(text).toContain(LENGTH_TRUNCATION_WARNING_TEXT)
    // the LIVE SSE stream itself never carries the warning (it can't — see appendLengthTruncationWarning's
    // doc comment: onFinish fires after every chunk is already on the wire).
    const frames = await readSse(
      await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: userTurn('go on again') })
      })
    )
    const wireText = frames
      .filter((f) => f.type === 'text-delta')
      .map((f) => String(f.delta))
      .join('')
    expect(wireText).not.toContain('⚠️')
  })

  test('a finishReason=stop turn (normal completion) carries NO warning', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: '1' },
                { type: 'text-delta' as const, id: '1', delta: 'all good' },
                { type: 'text-end' as const, id: '1' },
                STOP_FINISH
              ]
            })
          })
        }),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    await readSse(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(extractTextFromUIMessage(persisted[0].responseMessage)).toBe('all good')
  })

  test('a truncated (invalid) tool-call input under finishReason=length NEVER executes the tool, and the warning still appears', async () => {
    const executed: unknown[] = []
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...CHAT_CFG,
      // Test-only step cap: the AI SDK loop would otherwise take a second step to feed the model the
      // synthesized tool-error result for the invalid call; capping steps at 1 keeps this test to
      // a single deterministic doStream call regardless of that continuation semantics.
      internalMaxSteps: 1,
      createModel: () => mockLengthTruncatedToolCallModel('test_write', '{"content": "trunca'),
      buildTools: (): ToolSet => ({
        test_write: tool({
          description: 'test-only write tool',
          inputSchema: z.object({ content: z.string() }),
          execute: async (input) => {
            executed.push(input)
            return { ok: true }
          }
        })
      }),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('update it') })
    })
    await readSse(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    // the invalid tool call structurally never executes (ai@7 filters !toolCall.invalid before
    // executeTools — see research lane-c-write-truncation.md §3 assumption-1 disproof).
    expect(executed).toHaveLength(0)
    const text = extractTextFromUIMessage(persisted[0].responseMessage)
    expect(text).toContain(LENGTH_TRUNCATION_WARNING_TEXT)
  })

  test('maxOutputTokens is passed EXPLICITLY to the model call (owner 64k discipline)', async () => {
    const seenMaxOutputTokens: Array<number | undefined> = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async (opts) => {
            seenMaxOutputTokens.push(opts.maxOutputTokens)
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  { type: 'text-start' as const, id: '1' },
                  { type: 'text-delta' as const, id: '1', delta: 'ok' },
                  { type: 'text-end' as const, id: '1' },
                  STOP_FINISH
                ]
              })
            }
          }
        })
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    await readSse(res)
    // resolveModelFactory's legacy/test-mock branch doesn't set resolvedModel.maxOutputTokens, so
    // prepareChatRun's `?? 64_000` fallback is what reaches streamText here.
    expect(seenMaxOutputTokens).toEqual([64_000])
  })
})
