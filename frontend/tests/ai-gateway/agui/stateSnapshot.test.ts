// chat-panel P4 Phase 05 — AG-UI STATE_SNAPSHOT redaction tests.
//
// The snapshot is a SMALL, SAFE projection: no secrets, no full body (phase-05 §6). These tests
// lock that — a token / key in the context blob is dropped, a large body is truncated, and the
// capability flag highRiskApprovalRequired is always true.

import { describe, expect, test } from 'vitest'

import { AgUiEventType } from '../../../src/ai-gateway/agui/events'
import {
  MAX_SNAPSHOT_STRING,
  buildMailAgentAgUiState,
  redactForState,
  stateSnapshotEvent
} from '../../../src/ai-gateway/agui/stateSnapshot'

describe('agui stateSnapshot — redactForState', () => {
  test('drops secret-named keys at any depth', () => {
    const out = redactForState({
      provider_token: 'sk-zzz',
      apiKey: 'k',
      authorization: 'Bearer x',
      cookie: 'sid=1',
      password: 'p',
      note: 'keep me',
      nested: { access_token: 't', subject: 'hi', deep: { secret_value: 'q', ok: 1 } }
    }) as Record<string, unknown>

    expect(out.provider_token).toBeUndefined()
    expect(out.apiKey).toBeUndefined()
    expect(out.authorization).toBeUndefined()
    expect(out.cookie).toBeUndefined()
    expect(out.password).toBeUndefined()
    expect(out.note).toBe('keep me')
    const nested = out.nested as Record<string, unknown>
    expect(nested.access_token).toBeUndefined()
    expect(nested.subject).toBe('hi')
    expect((nested.deep as Record<string, unknown>).secret_value).toBeUndefined()
    expect((nested.deep as Record<string, unknown>).ok).toBe(1)
    // no secret value survives anywhere in the serialized output.
    expect(JSON.stringify(out)).not.toMatch(/sk-zzz|Bearer x|sid=1/)
  })

  test('truncates long strings (big body is not repeated whole)', () => {
    const big = 'A'.repeat(MAX_SNAPSHOT_STRING + 500)
    const out = redactForState({ body: big }) as { body: string }
    expect(out.body.length).toBeLessThan(big.length)
    expect(out.body).toMatch(/…\[truncated:\d+\]$/)
  })

  test('arrays keep order and are redacted element-wise', () => {
    const out = redactForState(['x', { token: 'drop', label: 'keep' }]) as unknown[]
    expect(out[0]).toBe('x')
    expect(out[1]).toEqual({ label: 'keep' })
  })
})

describe('agui stateSnapshot — buildMailAgentAgUiState', () => {
  test('builds redacted context + thread + capabilities (highRiskApprovalRequired always true)', () => {
    const state = buildMailAgentAgUiState({
      context: {
        body: 'B'.repeat(MAX_SNAPSHOT_STRING + 10),
        llm_token: 'sk-secret',
        subject: 'Re: x'
      },
      sessionId: 42,
      anchorType: 'email',
      anchorId: 51240,
      enabledTools: ['email_search', 'email_prepare_send'],
      enabledSkills: ['triage']
    })

    expect(state.thread).toEqual({ sessionId: 42, anchorType: 'email', anchorId: 51240 })
    expect(state.capabilities).toEqual({
      enabledTools: ['email_search', 'email_prepare_send'],
      enabledSkills: ['triage'],
      highRiskApprovalRequired: true
    })
    // context is redacted: no token, body truncated.
    const ctx = state.mailagentContext as Record<string, unknown>
    expect(ctx.llm_token).toBeUndefined()
    expect(String(ctx.body)).toMatch(/…\[truncated:\d+\]$/)
    expect(ctx.subject).toBe('Re: x')
    // 🔴 no provider key / token anywhere in the snapshot bytes.
    expect(JSON.stringify(state)).not.toMatch(/sk-secret/)
  })

  test('empty inputs default safely (general anchor, empty caps)', () => {
    const state = buildMailAgentAgUiState({})
    expect(state.thread).toEqual({ sessionId: null, anchorType: 'general', anchorId: null })
    expect(state.capabilities.enabledTools).toEqual([])
    expect(state.capabilities.highRiskApprovalRequired).toBe(true)
    expect(state.mailagentContext).toEqual({})
  })

  test('stateSnapshotEvent wraps into a STATE_SNAPSHOT event', () => {
    const state = buildMailAgentAgUiState({ sessionId: 1 })
    expect(stateSnapshotEvent(state)).toEqual({
      type: AgUiEventType.StateSnapshot,
      snapshot: state
    })
  })
})
