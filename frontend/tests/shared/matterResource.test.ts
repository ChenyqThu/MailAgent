import { describe, expect, test } from 'vitest'

import type { MatterResourceLookupResponse } from '../../src/shared/api/types/matter'
import {
  buildMatterResourceLookupKeys,
  deriveMatterLinkButtonState,
  mergeMatterResourceLinkHits,
  stripEmailSubjectPrefix
} from '../../src/shared/components/matters/matterResource'

describe('matter resource identity and toolbar state', () => {
  test('builds email and thread lookup keys without empty thread ids', () => {
    expect(buildMatterResourceLookupKeys(42856, 'AAQkAD')).toEqual(['email:42856', 'thread:AAQkAD'])
    expect(buildMatterResourceLookupKeys(42856, '  ')).toEqual(['email:42856'])
    expect(buildMatterResourceLookupKeys(null, null)).toEqual([])
  })

  test('derives unlinked, single, and multiple toolbar states', () => {
    expect(deriveMatterLinkButtonState(0)).toBe('unlinked')
    expect(deriveMatterLinkButtonState(1)).toBe('single')
    expect(deriveMatterLinkButtonState(3)).toBe('multiple')
  })

  test('merges email and thread hits and preserves subscription state', () => {
    const response: MatterResourceLookupResponse = {
      results: {
        'email:1': [hit({ resource_id: 10, link_id: 100, sub_state: 'none' })],
        'thread:t1': [hit({ resource_id: 11, link_id: 101, sub_state: 'active' })]
      }
    }
    const merged = mergeMatterResourceLinkHits(response, ['email:1', 'thread:t1'])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.links).toHaveLength(2)
    expect(merged[0]?.subscription?.sub_state).toBe('active')
  })

  test('strips one leading bracket prefix from an email subject', () => {
    expect(stripEmailSubjectPrefix('[External] Vendor launch')).toBe('Vendor launch')
    expect(stripEmailSubjectPrefix('Vendor launch')).toBe('Vendor launch')
  })
})

function hit(overrides: Partial<ReturnType<typeof baseHit>>) {
  return { ...baseHit(), ...overrides }
}

function baseHit() {
  return {
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    status: 'active' as const,
    health: 'on_track' as const,
    priority: 'p1' as const,
    link_id: 100,
    resource_id: 10,
    pinned: false,
    sub_state: 'none' as const,
    archived_at: null
  }
}
