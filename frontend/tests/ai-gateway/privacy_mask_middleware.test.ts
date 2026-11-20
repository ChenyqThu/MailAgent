import { describe, expect, it, vi } from 'vitest'

import {
  compilePrivacyRules,
  createPrivacyMaskMiddleware,
  trailingPlaceholderPrefixLength
} from '../../src/ai-gateway/privacyMaskMiddleware'
import { PrivacyMaskError, isPrivacyMaskError } from '../../src/ai-gateway/providerRef'

type MiddlewareHooks = {
  transformParams: (args: {
    type: 'generate' | 'stream'
    params: { prompt: unknown[] }
  }) => Promise<{ prompt: unknown[] }>
  wrapGenerate: (args: {
    doGenerate: () => Promise<{ content: unknown[] }>
    params: { prompt: unknown[] }
  }) => Promise<{ content: unknown[] }>
  wrapStream: (args: {
    doStream: () => Promise<{ stream: ReadableStream<Record<string, unknown>> }>
    params: { prompt: unknown[] }
  }) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>
}

function readAllChunks<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const out: T[] = []
  return (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value !== undefined) out.push(value)
    }
    return out
  })()
}

describe('privacyMaskMiddleware (Phase 5 WP-5A)', () => {
  it('masks SECRET/ID_CARD/BANK_CARD/PHONE/EMAIL/custom outbound and unmasks inbound generate output', async () => {
    const reportedHits: Array<Record<string, number>> = []
    const mw = createPrivacyMaskMiddleware(
      {
        builtIn: {
          secret: true,
          id_card: true,
          phone: true,
          email: true,
          bank_card: true
        },
        customRules: [
          {
            id: 'emp',
            name: 'Employee Badge',
            pattern: 'EMP-\\d{5}',
            tag: 'EMP_ID',
            enabled: true
          }
        ]
      },
      { onHits: (counts) => reportedHits.push(counts) }
    ) as unknown as MiddlewareHooks

    const secret = 'sk-ant-1234567890abcdefghij'
    const validId = '11010519491231002X'
    const invalidId = '110105194912310029'
    const validCard = '4532015112830366'
    const invalidCard = '4532015112830367'
    const phone = '+86 13812345678'
    const email = 'alice@example.com'
    const badge = 'EMP-00421'

    const rawPrompt = [
      {
        role: 'system',
        content: `System contact: ${email} (keep [[PII_EMAIL_99]])`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `secret=${secret} again=${secret} id=${validId} badid=${invalidId} card=${validCard} badcard=${invalidCard} phone=${phone} badge=${badge}`
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            output: {
              type: 'json',
              value: { ownerEmail: email, secret }
            }
          }
        ]
      }
    ]

    const transformed = await mw.transformParams({
      type: 'generate',
      params: { prompt: rawPrompt }
    })

    const wireText = JSON.stringify(transformed.prompt)
    for (const sensitive of [secret, validId, validCard, phone, email, badge]) {
      expect(wireText).not.toContain(sensitive)
    }
    expect(wireText).toContain(invalidId)
    expect(wireText).toContain(invalidCard)
    expect(wireText).toContain('[[PII_EMAIL_99]]')
    expect(wireText).toContain('[[PII_EMAIL_1]]')
    expect(wireText).toContain('[[PII_SECRET_1]]')
    expect(wireText).toContain('[[PII_EMP_ID_1]]')

    // Reported hits only carry category names + counts, never plaintext values.
    expect(reportedHits).toHaveLength(1)
    expect(reportedHits[0]).toEqual({
      email: 2,
      secret: 3,
      id_card: 1,
      bank_card: 1,
      phone: 1,
      'custom:emp': 1
    })
    expect(JSON.stringify(reportedHits)).not.toContain(email)
    expect(JSON.stringify(reportedHits)).not.toContain(secret)

    // Unmask text + JSON/string tool-call outputs.
    const generated = await mw.wrapGenerate({
      params: { prompt: transformed.prompt },
      doGenerate: async () => ({
        content: [
          { type: 'text', text: 'Send receipt to [[PII_EMAIL_1]] for [[PII_EMP_ID_1]].' },
          { type: 'tool-call', toolName: 'save', input: { card: '[[PII_BANK_CARD_1]]', id: '[[PII_ID_CARD_1]]' } }
        ]
      })
    })

    expect(generated.content[0]).toEqual({
      type: 'text',
      text: `Send receipt to ${email} for ${badge}.`
    })
    expect(generated.content[1]).toEqual({
      type: 'tool-call',
      toolName: 'save',
      input: { card: validCard, id: validId }
    })
  })

  it('holds back split placeholder tokens across wrapStream chunks and JSON-escapes tool-input-delta', async () => {
    expect(trailingPlaceholderPrefixLength('Hello [[PII_EM')).toBe('[[PII_EM'.length)
    expect(trailingPlaceholderPrefixLength('Hello [[PII_EMAIL_1]] world')).toBe(0)

    const mw = createPrivacyMaskMiddleware({
      builtIn: { secret: false, id_card: false, phone: false, email: true, bank_card: false },
      customRules: [
        {
          id: 'quoted',
          name: 'Quoted Value',
          pattern: 'QVAL-[^\\s]+',
          tag: 'QUOTED',
          enabled: true
        }
      ]
    }) as unknown as MiddlewareHooks

    const rawQuoted = 'QVAL-a"b\\c'
    const transformed = await mw.transformParams({
      type: 'stream',
      params: {
        prompt: [
          {
            role: 'user',
            content: [{ type: 'text', text: `Email alice@example.com and value ${rawQuoted}` }]
          }
        ]
      }
    })

    const maskedWire = JSON.stringify(transformed.prompt)
    expect(maskedWire).not.toContain('alice@example.com')
    expect(maskedWire).not.toContain(rawQuoted)

    const chunks = [
      { type: 'text-delta', id: 't1', delta: 'Reach [' },
      { type: 'text-delta', id: 't1', delta: '[PII_' },
      { type: 'text-delta', id: 't1', delta: 'EMAIL_' },
      { type: 'text-delta', id: 't1', delta: '1]] today!' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-delta', id: 'tc1', delta: '{"val":"[[PII_QUO' },
      { type: 'tool-input-delta', id: 'tc1', delta: 'TED_1]]"}' },
      { type: 'tool-input-end', id: 'tc1' },
      { type: 'tool-call', toolCallId: 'tc1', input: { raw: '[[PII_EMAIL_1]]' } },
      { type: 'finish' }
    ]

    const stream = new ReadableStream<Record<string, unknown>>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      }
    })

    const out = await mw.wrapStream({
      params: { prompt: transformed.prompt },
      doStream: async () => ({ stream })
    })

    const collected = await readAllChunks(out.stream)
    const textDeltas = collected
      .filter((c) => c.type === 'text-delta')
      .map((c) => String(c.delta))
      .join('')
    expect(textDeltas).toBe('Reach alice@example.com today!')

    const toolJsonText = collected
      .filter((c) => c.type === 'tool-input-delta')
      .map((c) => String(c.delta))
      .join('')
    expect(JSON.parse(toolJsonText)).toEqual({ val: rawQuoted })

    const toolCallChunk = collected.find((c) => c.type === 'tool-call')
    expect(toolCallChunk?.input).toEqual({ raw: 'alice@example.com' })
  })

  it('fails closed with PrivacyMaskError (E_PRIVACY_MASK_FAILED) on unsafe or invalid rules', async () => {
    for (const pattern of ['(a+)+b', '[unclosed', 'a*']) {
      let thrown: unknown
      try {
        compilePrivacyRules({
          builtIn: { secret: false, id_card: false, phone: false, email: false, bank_card: false },
          customRules: [{ id: 'bad', name: 'Bad', pattern, tag: 'BAD', enabled: true }]
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(PrivacyMaskError)
      expect(isPrivacyMaskError(thrown)).toBe(true)
      expect((thrown as PrivacyMaskError).code).toBe('E_PRIVACY_MASK_FAILED')
    }

    // Best-effort onHits throwing must not break outbound masking if rules themselves succeed.
    const throwingHits = vi.fn(() => {
      throw new Error('metrics offline')
    })
    const mw = createPrivacyMaskMiddleware(
      { builtIn: { email: true, secret: false, id_card: false, phone: false, bank_card: false }, customRules: [] },
      { onHits: throwingHits }
    ) as unknown as MiddlewareHooks
    await expect(
      mw.transformParams({
        type: 'generate',
        params: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'a@b.com' }] }] }
      })
    ).resolves.toBeTruthy()
  })
})
