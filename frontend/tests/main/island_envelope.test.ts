// Sprint 9 D3 — pure envelope-builder tests.
//
// No mocks; the builders are deterministic except for `id` (UUID) and
// `sentAt` (Date.now()), both of which we override via the `now` opt for
// the encoding tests.

import { describe, expect, test } from 'vitest'

import {
  buildAIDraftReady,
  buildAIDraftStart,
  buildAIDraftStream,
  buildAppearanceChange,
  buildPing,
  serializeEnvelope,
  swiftSentAt
} from '../../src/electron/main/island'

describe('island envelope: swiftSentAt', () => {
  test('1970-01-01T00:00:00Z (epoch 0) encodes to -978307200', () => {
    expect(swiftSentAt(0)).toBeCloseTo(-978_307_200, 3)
  })

  test('2001-01-01T00:00:00Z (Swift reference epoch) encodes to 0', () => {
    const swiftReferenceMs = Date.UTC(2001, 0, 1, 0, 0, 0)
    expect(swiftSentAt(swiftReferenceMs)).toBeCloseTo(0, 3)
  })

  test('millisecond precision survives float64', () => {
    // 25 years past Swift reference — should round-trip well under 0.1ms.
    const now = Date.UTC(2026, 4, 17, 0, 0, 0, 123)
    const got = swiftSentAt(now)
    const expected = now / 1000 - 978_307_200
    expect(Math.abs(got - expected)).toBeLessThan(0.001)
  })
})

describe('island envelope: buildAppearanceChange', () => {
  test('shape carries provider/eventType/sessionKey + metadata', () => {
    const env = buildAppearanceChange({ accent: 'cobalt', theme: 'dark' })
    expect(env.provider).toBe('mail')
    // Sprint 10 (b) §2.5.4-D Plan A — wire eventType collapses to
    // 'Notification' so ping-island's dispatcher accepts the frame; the
    // semantic event lives in metadata.mailagent.eventType.
    expect(env.eventType).toBe('Notification')
    expect(env.metadata['mailagent.eventType']).toBe('AppearanceChange')
    expect(env.sessionKey).toBe('mailagent:system:appearance')
    expect(env.status.kind).toBe('notification')
    expect(env.expectsResponse).toBe(false)
    expect(env.metadata['mailagent.accent']).toBe('cobalt')
    expect(env.metadata['mailagent.theme']).toBe('dark')
  })

  test('lang opt is included when supplied', () => {
    const env = buildAppearanceChange({ accent: 'coral', theme: 'light', lang: 'zh-CN' })
    expect(env.metadata['mailagent.lang']).toBe('zh-CN')
  })

  test('omits lang field when not supplied', () => {
    const env = buildAppearanceChange({ accent: 'coral', theme: 'light' })
    expect(env.metadata['mailagent.lang']).toBeUndefined()
  })

  test('id is a fresh UUID per call (no static collision)', () => {
    const a = buildAppearanceChange({ accent: 'coral', theme: 'dark' })
    const b = buildAppearanceChange({ accent: 'coral', theme: 'dark' })
    expect(a.id).not.toEqual(b.id)
  })
})

describe('island envelope: AI draft 3-phase builders', () => {
  test('AIDraftStart packs emailId/sender/subject/prompt into metadata', () => {
    const env = buildAIDraftStart({
      emailId: 53675,
      senderName: 'John Smith',
      subject: 'Catch Up meeting SaaS 2026 Plan',
      prompt: '请帮我起草一份回复,简短礼貌'
    })
    expect(env.eventType).toBe('Notification')
    expect(env.metadata['mailagent.eventType']).toBe('AIDraftStart')
    expect(env.sessionKey).toBe('mailagent:chat:53675')
    expect(env.metadata['mailagent.internalId']).toBe('53675')
    expect(env.metadata['mailagent.senderName']).toBe('John Smith')
    expect(env.metadata['mailagent.subject']).toBe('Catch Up meeting SaaS 2026 Plan')
    expect(env.metadata['mailagent.draftPhase']).toBe('start')
    expect(env.metadata['mailagent.prompt']).toMatch(/^请帮我起草一份回复/)
    expect(env.title).toContain('John Smith')
  })

  test('AIDraftStart copes with null sender/subject', () => {
    const env = buildAIDraftStart({
      emailId: 100,
      senderName: null,
      subject: null,
      prompt: 'hi'
    })
    expect(env.metadata['mailagent.senderName']).toBe('')
    expect(env.metadata['mailagent.subject']).toBe('')
    expect(env.title).toContain('—')
  })

  test('AIDraftStart clips prompt to 240 chars + ellipsis', () => {
    const long = 'a'.repeat(500)
    const env = buildAIDraftStart({ emailId: 1, senderName: null, subject: null, prompt: long })
    const clipped = env.metadata['mailagent.prompt']
    expect(clipped.length).toBeLessThanOrEqual(240)
    expect(clipped.endsWith('…')).toBe(true)
  })

  test('AIDraftStream metadata = phase=stream + streamedChars', () => {
    const env = buildAIDraftStream({ emailId: 42, streamedChars: 1024 })
    expect(env.eventType).toBe('Notification')
    expect(env.metadata['mailagent.eventType']).toBe('AIDraftStream')
    expect(env.sessionKey).toBe('mailagent:chat:42')
    expect(env.metadata['mailagent.draftPhase']).toBe('stream')
    expect(env.metadata['mailagent.streamedChars']).toBe('1024')
  })

  test('AIDraftReady sets status.kind=completed + ready phase', () => {
    const env = buildAIDraftReady({
      emailId: 53675,
      senderName: 'John',
      subject: 'RE: Catch Up',
      preview: 'Hi John, thanks for the heads-up.'
    })
    expect(env.eventType).toBe('Notification')
    expect(env.metadata['mailagent.eventType']).toBe('AIDraftReady')
    expect(env.status.kind).toBe('completed')
    expect(env.metadata['mailagent.draftPhase']).toBe('ready')
    expect(env.preview).toContain('Hi John')
  })

  test('AIDraftReady preview clips at 240 chars too', () => {
    const long = 'b'.repeat(500)
    const env = buildAIDraftReady({ emailId: 1, senderName: null, subject: null, preview: long })
    expect(env.preview.length).toBeLessThanOrEqual(240)
    expect(env.preview.endsWith('…')).toBe(true)
  })
})

describe('island envelope: buildPing', () => {
  test('liveness metadata + system sessionKey', () => {
    const env = buildPing()
    expect(env.eventType).toBe('Notification')
    expect(env.metadata['mailagent.eventType']).toBe('Ping')
    expect(env.sessionKey).toBe('mailagent:system:ping')
    expect(env.metadata['mailagent.kind']).toBe('liveness')
    expect(env.expectsResponse).toBe(false)
  })
})

describe('island envelope: serializeEnvelope', () => {
  test('returns a UTF-8 Buffer that JSON.parses back to the envelope', () => {
    const env = buildAppearanceChange({ accent: 'coral', theme: 'dark' })
    const bytes = serializeEnvelope(env)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    const parsed = JSON.parse(bytes.toString('utf8'))
    expect(parsed.provider).toBe('mail')
    expect(parsed.eventType).toBe('Notification')
    expect(parsed.metadata['mailagent.eventType']).toBe('AppearanceChange')
    expect(parsed.metadata['mailagent.accent']).toBe('coral')
  })

  test('UTF-8 round-trip preserves CJK characters', () => {
    const env = buildAIDraftStart({
      emailId: 1,
      senderName: '张三',
      subject: '会议确认',
      prompt: 'hi'
    })
    const bytes = serializeEnvelope(env)
    const parsed = JSON.parse(bytes.toString('utf8'))
    expect(parsed.metadata['mailagent.senderName']).toBe('张三')
    expect(parsed.metadata['mailagent.subject']).toBe('会议确认')
  })
})
