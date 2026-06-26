// Phase 10b — configurable LLM auto-title: the gateway /api/ai/title endpoint + the title
// generation/sanitization helpers. Pure-Node: a MockLanguageModelV3 is injected via cfg.createModel
// so generateText runs WITHOUT a real provider call; getTitleContext / saveSessionTitle are spies so
// we assert the read/skip/persist behaviour (idempotent on an already-titled session).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import {
  buildTitlePrompt,
  generateSessionTitle,
  sanitizeSessionTitle
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

/** A v3 language model whose generate (non-stream) call returns a fixed title text. */
function mockTitleModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      warnings: []
    })
  })
}

const postTitle = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/ai/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

// ── sanitizeSessionTitle (the clean-up of a model-generated title) ───────────────────────────────

describe('sanitizeSessionTitle', () => {
  test('strips wrapping quotes (ASCII + CJK)', () => {
    expect(sanitizeSessionTitle('"Draft a reply"')).toBe('Draft a reply')
    expect(sanitizeSessionTitle('「项目周报」')).toBe('项目周报')
  })
  test('drops a leading "Title:" / "标题：" label', () => {
    expect(sanitizeSessionTitle('Title: Quarterly plan')).toBe('Quarterly plan')
    expect(sanitizeSessionTitle('标题：季度计划')).toBe('季度计划')
  })
  test('collapses whitespace and drops a trailing period', () => {
    expect(sanitizeSessionTitle('Weekly   sync  notes.')).toBe('Weekly sync notes')
    expect(sanitizeSessionTitle('日报\n汇总。')).toBe('日报 汇总')
  })
  test('caps the length at 60', () => {
    const out = sanitizeSessionTitle('x'.repeat(120))
    expect(out).not.toBeNull()
    expect(out!.length).toBe(60)
  })
  test('empty / clean-to-empty → null', () => {
    expect(sanitizeSessionTitle('   ')).toBeNull()
    expect(sanitizeSessionTitle('""')).toBeNull()
  })
})

describe('buildTitlePrompt', () => {
  test('embeds the user text and the length/quote/language constraints', () => {
    const p = buildTitlePrompt('帮我写一封请假邮件')
    expect(p).toContain('帮我写一封请假邮件')
    expect(p).toContain('at most 6 words')
    expect(p).toContain('SAME language')
  })
  test('clips an enormous body to 1000 chars', () => {
    const p = buildTitlePrompt('a'.repeat(5000))
    // prompt = preamble + clipped body; the body portion must be capped at 1000.
    expect(p).toContain('a'.repeat(1000))
    expect(p).not.toContain('a'.repeat(1001))
  })
})

// ── generateSessionTitle (model factory → cleaned title) ──────────────────────────────────────────

describe('generateSessionTitle', () => {
  test('generates + sanitizes (quotes stripped)', async () => {
    const cfg = {
      port: 0,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      model: 'm',
      createModel: () => mockTitleModel('"Vacation request email"')
    } as AiGatewayConfig
    const title = await generateSessionTitle(cfg, '帮我写一封请假邮件', 'claude-haiku-4-5')
    expect(title).toBe('Vacation request email')
  })
  test('a blank model reply → null', async () => {
    const cfg = {
      port: 0,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      model: 'm',
      createModel: () => mockTitleModel('   ')
    } as AiGatewayConfig
    expect(await generateSessionTitle(cfg, 'hi', 'm')).toBeNull()
  })
})

// ── POST /api/ai/title endpoint ───────────────────────────────────────────────────────────────────

describe('POST /api/ai/title', () => {
  test('no getTitleContext/saveSessionTitle wired → 501', async () => {
    await withServer({}, async (base) => {
      const res = await postTitle(base, { sessionId: 1 })
      expect(res.status).toBe(501)
      expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
    })
  })

  test('no api key → 503', async () => {
    await withServer(
      {
        apiKey: null,
        getTitleContext: () => ({ title: null, firstUserText: 'hi' }),
        saveSessionTitle: () => {}
      },
      async (base) => {
        const res = await postTitle(base, { sessionId: 1 })
        expect(res.status).toBe(503)
        expect((await res.json()).error).toBe('E_NO_LLM_KEY')
      }
    )
  })

  test('missing sessionId → 400', async () => {
    await withServer({ getTitleContext: () => null, saveSessionTitle: () => {} }, async (base) => {
      const res = await postTitle(base, {})
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('E_INVALID_ARG')
    })
  })

  test('session not found → 404', async () => {
    await withServer({ getTitleContext: () => null, saveSessionTitle: () => {} }, async (base) => {
      const res = await postTitle(base, { sessionId: 9 })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('E_NOT_FOUND')
    })
  })

  test('session with no user message → 404', async () => {
    await withServer(
      {
        getTitleContext: () => ({ title: null, firstUserText: null }),
        saveSessionTitle: () => {}
      },
      async (base) => {
        const res = await postTitle(base, { sessionId: 9 })
        expect(res.status).toBe(404)
      }
    )
  })

  test('already-titled session → 200 skipped, never regenerated (manual rename safe)', async () => {
    const save = vi.fn()
    await withServer(
      {
        getTitleContext: () => ({ title: 'My manual title', firstUserText: 'hi' }),
        saveSessionTitle: save,
        createModel: () => mockTitleModel('AI Title')
      },
      async (base) => {
        const res = await postTitle(base, { sessionId: 9 })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { title: string; skipped: boolean }
        expect(body.title).toBe('My manual title')
        expect(body.skipped).toBe(true)
        expect(save).not.toHaveBeenCalled()
      }
    )
  })

  test('untitled session → generates, persists, returns the title', async () => {
    const save = vi.fn()
    await withServer(
      {
        getTitleContext: () => ({ title: null, firstUserText: '帮我写一封请假邮件' }),
        saveSessionTitle: save,
        createModel: () => mockTitleModel('"请假邮件草稿"')
      },
      async (base) => {
        const res = await postTitle(base, { sessionId: 9, model: 'claude-haiku-4-5' })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { title: string }
        expect(body.title).toBe('请假邮件草稿')
        expect(save).toHaveBeenCalledWith(9, '请假邮件草稿')
      }
    )
  })
})
