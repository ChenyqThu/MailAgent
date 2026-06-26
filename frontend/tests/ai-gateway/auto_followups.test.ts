// dogfood-3 — dynamic follow-ups: the gateway /api/ai/followups endpoint + the parse / build / generate
// helpers. Pure-Node: a MockLanguageModelV3 is injected via cfg.createModel so generateText runs WITHOUT
// a real provider; getFollowupContext is a stub so we assert read + per-turn (non-idempotent) behaviour.
// Mirrors auto_title.test.ts (the same small-model endpoint pattern).

import { afterEach, describe, expect, test } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import {
  buildFollowupsPrompt,
  generateFollowups,
  parseFollowups
} from '../../src/ai-gateway/chatRun'
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

/** A v3 language model whose generate (non-stream) call returns a fixed follow-ups text. */
function mockFollowupsModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      warnings: []
    })
  })
}

const postFollowups = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/ai/followups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

// ── parseFollowups (the clean-up of model output) ─────────────────────────────────────────────────

describe('parseFollowups', () => {
  test('parses a JSON array', () => {
    expect(parseFollowups('["帮我回复第一封", "标记为已读"]')).toEqual([
      '帮我回复第一封',
      '标记为已读'
    ])
  })
  test('parses a newline / numbered list when not JSON', () => {
    expect(parseFollowups('1. What is the deadline?\n2. Who is the owner?')).toEqual([
      'What is the deadline?',
      'Who is the owner?'
    ])
  })
  test('strips bullets / quotes, dedups, caps at 3', () => {
    expect(parseFollowups('- "A"\n- A\n* B\n- C\n- D')).toEqual(['A', 'B', 'C'])
  })
  test('caps each item at 80 chars; drops empties', () => {
    const out = parseFollowups(`["${'x'.repeat(120)}", "", "  "]`)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBe(80)
  })
  test('blank / garbage → []', () => {
    expect(parseFollowups('   ')).toEqual([])
  })
})

describe('buildFollowupsPrompt', () => {
  test('embeds both texts + the JSON-array / language constraints', () => {
    const p = buildFollowupsPrompt('总结未读邮件', '你有 3 封未读邮件')
    expect(p).toContain('总结未读邮件')
    expect(p).toContain('你有 3 封未读邮件')
    expect(p).toContain('JSON array')
    expect(p).toContain('SAME language')
  })
  test('clips long bodies (user 800 / assistant 1500)', () => {
    const p = buildFollowupsPrompt('u'.repeat(2000), 'a'.repeat(3000))
    expect(p).toContain('u'.repeat(800))
    expect(p).not.toContain('u'.repeat(801))
    expect(p).toContain('a'.repeat(1500))
    expect(p).not.toContain('a'.repeat(1501))
  })
})

// ── generateFollowups (model factory → parsed list) ───────────────────────────────────────────────

describe('generateFollowups', () => {
  test('generates + parses a JSON array', async () => {
    const cfg = {
      port: 0,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      model: 'm',
      createModel: () => mockFollowupsModel('["A?", "B?"]')
    } as AiGatewayConfig
    expect(await generateFollowups(cfg, 'u', 'a', 'claude-haiku-4-5')).toEqual(['A?', 'B?'])
  })
})

// ── POST /api/ai/followups endpoint ───────────────────────────────────────────────────────────────

describe('POST /api/ai/followups', () => {
  test('no getFollowupContext wired → 501', async () => {
    await withServer({}, async (base) => {
      const res = await postFollowups(base, { sessionId: 1 })
      expect(res.status).toBe(501)
      expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
    })
  })
  test('no api key → 503', async () => {
    await withServer(
      { apiKey: null, getFollowupContext: () => ({ userText: 'u', assistantText: 'a' }) },
      async (base) => {
        const res = await postFollowups(base, { sessionId: 1 })
        expect(res.status).toBe(503)
      }
    )
  })
  test('missing sessionId → 400', async () => {
    await withServer(
      { getFollowupContext: () => ({ userText: 'u', assistantText: 'a' }) },
      async (base) => {
        const res = await postFollowups(base, {})
        expect(res.status).toBe(400)
      }
    )
  })
  test('no completed turn → 200 with empty followups (not an error)', async () => {
    await withServer({ getFollowupContext: () => null }, async (base) => {
      const res = await postFollowups(base, { sessionId: 1 })
      expect(res.status).toBe(200)
      expect((await res.json()).followups).toEqual([])
    })
  })
  test('a completed turn → 200 with generated followups', async () => {
    await withServer(
      {
        getFollowupContext: () => ({ userText: '总结未读', assistantText: '你有 3 封' }),
        createModel: () => mockFollowupsModel('["帮我回复", "全部已读"]')
      },
      async (base) => {
        const res = await postFollowups(base, { sessionId: 1 })
        expect(res.status).toBe(200)
        expect((await res.json()).followups).toEqual(['帮我回复', '全部已读'])
      }
    )
  })
})
