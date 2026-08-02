import { describe, expect, test } from 'vitest'

import {
  REPORT_BLOCK_TYPES,
  REPORT_CADENCES,
  reportBlockInputSchema,
  validateReportBlocks
} from '../../src/shared/api/reportBlocks'

describe('report block runtime contract', () => {
  test('pins the public cadence and block vocabularies', () => {
    expect(REPORT_CADENCES).toEqual(['daily', 'weekly', 'monthly', 'custom'])
    expect(REPORT_BLOCK_TYPES).toContain('markdown')
    expect(REPORT_BLOCK_TYPES).toContain('image')
  })

  test('one invalid known block degrades to UnknownBlock without dropping valid siblings', () => {
    const blocks = validateReportBlocks([
      { type: 'timeline', title: 'Broken timeline', events: 'not-an-array' },
      { type: 'quote', text: 'Still renders' }
    ])

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      type: 'invalid',
      original_type: 'timeline',
      title: 'Broken timeline'
    })
    expect(blocks[1]).toEqual({ type: 'quote', text: 'Still renders' })
  })

  test('arbitrary network image sources are rejected at the model boundary', () => {
    expect(
      reportBlockInputSchema.safeParse({
        type: 'image',
        src: 'https://tracking.example/pixel.png',
        alt: 'tracking pixel'
      }).success
    ).toBe(false)
    expect(
      reportBlockInputSchema.safeParse({ type: 'image', src: '/api/attachments/42', alt: 'local' })
        .success
    ).toBe(true)
  })
})
