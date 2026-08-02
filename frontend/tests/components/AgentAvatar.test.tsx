import { describe, expect, test } from 'vitest'

import {
  resolveAgentAvatar,
  shuffledAgentAvatar
} from '../../src/shared/components/agents/agentAvatarIdentity'

describe('AgentAvatar identity', () => {
  test('empty config derives a stable shape, palette, and variant from agent id', () => {
    const first = resolveAgentAvatar('daily_email_digest')
    const second = resolveAgentAvatar('daily_email_digest')
    expect(second).toEqual(first)
    expect(first.variant_id).toBe('daily_email_digest')
  })

  test('explicit supported identity wins and malformed identity falls back', () => {
    const explicit = { shape: 'nova' as const, palette: 'aurora-pink', variant_id: 'custom:v2' }
    expect(resolveAgentAvatar('custom', explicit)).toEqual(explicit)
    expect(
      resolveAgentAvatar('custom', {
        shape: 'nova',
        palette: 'missing-palette',
        variant_id: 'bad'
      })
    ).toEqual(resolveAgentAvatar('custom'))
  })

  test('shuffle returns a different but deterministic persisted identity', () => {
    const current = resolveAgentAvatar('custom')
    const next = shuffledAgentAvatar('custom', current)
    expect(next).not.toEqual(current)
    expect(resolveAgentAvatar('custom', next)).toEqual(next)
    expect(shuffledAgentAvatar('custom', current)).toEqual(next)
  })
})
