// chat-panel P4 Phase 04b — outbound content hash + token signing + safety heuristics.
//
// The send double guard depends on the gateway (TS) and the Python serve-api computing the
// BYTE-IDENTICAL content hash + HMAC token for the same payload. This suite pins:
//   - the canonical form (version prefix, recipient normalization, verbatim subject/body);
//   - a CROSS-LANGUAGE golden hash that MUST equal src/services/send_guard.py's output for the
//     same payload (tests/services/test_send_guard.py asserts the Python side of the same vector);
//   - the HMAC token signing-message format + determinism;
//   - the external-recipient + sensitive-term warning heuristics the SendApprovalCard surfaces.

import { describe, expect, test } from 'vitest'

import { createHmac } from 'node:crypto'

import {
  OUTBOUND_CANONICAL_VERSION,
  canonicalizeOutbound,
  hashOutboundPayload,
  detectExternalRecipients,
  detectSensitiveTerms
} from '../../../src/shared/assistant/tools/security/hashOutboundPayload'
import {
  hashOutbound,
  sha256hex,
  sendApprovalSigningMessage,
  signSendApprovalToken
} from '../../../src/ai-gateway/security/sendToken'

describe('canonicalizeOutbound', () => {
  test('version prefix + trimmed/compacted recipients + verbatim subject/body, newline-joined', () => {
    const canonical = canonicalizeOutbound({
      to: ['  a@x.com ', 'b@y.com', '  '],
      cc: ['c@z.com'],
      bcc: [],
      subject: 'Hello 你好',
      body: 'Body line1\nline2  '
    })
    expect(canonical).toBe('v1\na@x.com,b@y.com\nc@z.com\n\nHello 你好\nBody line1\nline2  ')
    expect(OUTBOUND_CANONICAL_VERSION).toBe('v1')
  })

  test('recipient ORDER is preserved (not sorted) — order is part of the binding', () => {
    const a = canonicalizeOutbound({ to: ['a@x.com', 'b@x.com'], subject: 's', body: 'b' })
    const b = canonicalizeOutbound({ to: ['b@x.com', 'a@x.com'], subject: 's', body: 'b' })
    expect(a).not.toBe(b)
  })
})

describe('hashOutbound (gateway) ↔ Python cross-language golden', () => {
  // 🔴 This exact hex MUST equal src/services/send_guard.py hash_outbound() for the same payload
  // (the Python suite asserts the same vector). If this changes, the gateway and Python diverge
  // and EVERY send would be rejected E_SEND_HASH_MISMATCH — a hard cross-language contract.
  const GOLDEN = 'f20307313f87a208e2b8884e93922f4ffa324e6e8b8507f44245f6ff94b97bff'

  test('the gateway hashOutbound matches the committed cross-language golden', () => {
    const hex = hashOutbound({
      to: ['  a@x.com ', 'b@y.com'],
      cc: ['c@z.com'],
      bcc: [],
      subject: 'Hello 你好',
      body: 'Body line1\nline2  '
    })
    expect(hex).toBe(GOLDEN)
  })

  test('hashOutboundPayload(payload, sha256hex) equals the gateway hashOutbound', () => {
    const payload = { to: ['a@x.com'], subject: 's', body: 'b' }
    expect(hashOutboundPayload(payload, sha256hex)).toBe(hashOutbound(payload))
  })

  test('a single changed body character changes the hash (content integrity)', () => {
    const base = { to: ['a@x.com'], subject: 's', body: 'pay 100' }
    const tampered = { to: ['a@x.com'], subject: 's', body: 'pay 900' }
    expect(hashOutbound(base)).not.toBe(hashOutbound(tampered))
  })
})

describe('signSendApprovalToken', () => {
  test('signing message is {contentHash}.{idempotencyKey}.{expiresAt} (base-10)', () => {
    expect(
      sendApprovalSigningMessage({ contentHash: 'h', idempotencyKey: 'i', expiresAt: 42 })
    ).toBe('h.i.42')
  })

  test('HMAC matches node:crypto over the signing message (deterministic)', () => {
    const env = { contentHash: 'abc', idempotencyKey: 'idem-1', expiresAt: 1_700_000_000_000 }
    const token = signSendApprovalToken('secret-key', env)
    const expected = createHmac('sha256', 'secret-key')
      .update('abc.idem-1.1700000000000', 'utf8')
      .digest('hex')
    expect(token).toBe(expected)
  })

  test('a different secret / content / idempotency / expiry yields a different token', () => {
    const env = { contentHash: 'h', idempotencyKey: 'i', expiresAt: 1 }
    const base = signSendApprovalToken('s', env)
    expect(signSendApprovalToken('s2', env)).not.toBe(base)
    expect(signSendApprovalToken('s', { ...env, contentHash: 'h2' })).not.toBe(base)
    expect(signSendApprovalToken('s', { ...env, idempotencyKey: 'i2' })).not.toBe(base)
    expect(signSendApprovalToken('s', { ...env, expiresAt: 2 })).not.toBe(base)
  })
})

describe('detectExternalRecipients', () => {
  test('flags free/personal webmail recipients (no org config)', () => {
    const ext = detectExternalRecipients({
      to: ['colleague@example-corp.test', 'someone@gmail.com'],
      cc: ['friend@qq.com'],
      bcc: []
    })
    expect(ext).toEqual(['someone@gmail.com', 'friend@qq.com'])
  })

  test('with internalDomains, flags anything NOT on those domains', () => {
    const ext = detectExternalRecipients(
      { to: ['me@corp.test', 'partner@vendor.test'], cc: [], bcc: [] },
      ['corp.test']
    )
    expect(ext).toEqual(['partner@vendor.test'])
  })

  test('all-internal recipients → no warning', () => {
    expect(
      detectExternalRecipients({ to: ['a@corp.test'], cc: [], bcc: [] }, ['corp.test'])
    ).toEqual([])
  })
})

describe('detectSensitiveTerms', () => {
  test('matches English + CJK sensitive terms in subject/body (case-insensitive)', () => {
    const terms = detectSensitiveTerms({
      subject: 'Please WIRE TRANSFER the deposit',
      body: '账号见附件，另附登录密码。'
    })
    expect(terms).toContain('wire transfer')
    expect(terms).toContain('账号')
    expect(terms).toContain('密码')
  })

  test('benign content → no terms', () => {
    expect(detectSensitiveTerms({ subject: '周会纪要', body: '已同步给团队。' })).toEqual([])
  })
})
