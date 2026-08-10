import { describe, expect, test } from 'vitest'

import type { Matter } from '../../../src/shared/api/types/matter'
import {
  buildPaletteMatterLookupKeys,
  getMatterMatchDetails,
  matterFieldLabelKey,
  paletteScopeVisibility
} from '../../../src/shared/components/command/paletteMatters'

describe('palette matter helpers', () => {
  test('maps matched fields to palette i18n keys', () => {
    expect(matterFieldLabelKey('title')).toBe('palette.matters.fields.title')
    expect(matterFieldLabelKey('description')).toBe('palette.matters.fields.description')
    expect(matterFieldLabelKey('current_summary')).toBe('palette.matters.fields.currentSummary')
    expect(matterFieldLabelKey('status')).toBe('palette.matters.fields.status')
    expect(matterFieldLabelKey('items')).toBe('palette.matters.fields.items')
    expect(matterFieldLabelKey('stakeholders')).toBe('palette.matters.fields.stakeholders')
    expect(matterFieldLabelKey('notes')).toBe('palette.matters.fields.notes')
  })

  test('limits matched field details and reports overflow', () => {
    const result = getMatterMatchDetails({
      matched_fields: ['title', 'items', 'stakeholders'],
      snippets: { title: 'Vendor renewal', items: 'Confirm pricing', stakeholders: 'Alice' }
    } satisfies Pick<Matter, 'matched_fields' | 'snippets'>)

    expect(result).toEqual({
      details: [
        {
          field: 'title',
          labelKey: 'palette.matters.fields.title',
          snippet: 'Vendor renewal'
        },
        {
          field: 'items',
          labelKey: 'palette.matters.fields.items',
          snippet: 'Confirm pricing'
        }
      ],
      overflow: 1
    })
  })

  test('filters provider groups by scope', () => {
    expect(paletteScopeVisibility('all')).toEqual({
      showEmail: true,
      showMatter: true,
      showNonProviderGroups: true
    })
    expect(paletteScopeVisibility('email')).toEqual({
      showEmail: true,
      showMatter: false,
      showNonProviderGroups: true
    })
    expect(paletteScopeVisibility('matter')).toEqual({
      showEmail: false,
      showMatter: true,
      showNonProviderGroups: false
    })
  })

  test('builds unique lookup keys with a hard limit of 50', () => {
    const hits = [
      { internal_id: 2 },
      { internal_id: 2 },
      ...Array.from({ length: 60 }, (_, index) => ({ internal_id: index + 3 }))
    ]

    const keys = buildPaletteMatterLookupKeys(hits, true)
    expect(keys).toHaveLength(50)
    expect(keys.slice(0, 3)).toEqual(['email:2', 'email:3', 'email:4'])
    expect(new Set(keys).size).toBe(50)
  })

  test('returns no lookup keys when matters are disabled', () => {
    expect(buildPaletteMatterLookupKeys([{ internal_id: 42 }], false)).toEqual([])
  })
})
