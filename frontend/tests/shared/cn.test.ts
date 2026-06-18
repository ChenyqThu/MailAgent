// Regression guard for the cn() / tailwind-merge custom-fontSize fix.
//
// MailAgent defines a custom fontSize scale (tailwind.config.ts: micro/meta/
// aux/body/lead/subj). Stock tailwind-merge doesn't know these, so it grouped
// `text-micro` (size) together with `text-ink-fg-1` (custom color) as one
// conflicting `text-*` group and dropped the earlier one — i.e. for the common
// `cn('… text-micro … text-ink-fg-1')` shape (size first, color last) the
// FONT SIZE was silently stripped and the element fell back to its inherited
// (larger) size. Visible fallout: AI-chat tool "Result" toggle, the confirm
// dialog banner/buttons, etc. all rendered oversized.
//
// cn.ts fixes this via extendTailwindMerge, registering the custom sizes into
// the font-size group so size + text-color land in separate groups and both
// survive. These tests lock that in.

import { describe, expect, test } from 'vitest'

import { cn } from '../../src/shared/lib/cn'

describe('cn — custom fontSize survives alongside custom text-color', () => {
  test('text-micro is kept when a custom text color follows (the regressed shape)', () => {
    const out = cn('bg-ink-2 border text-micro font-mono text-ink-fg-1')
    expect(out).toContain('text-micro')
    expect(out).toContain('text-ink-fg-1')
  })

  test('every custom size survives next to a custom color', () => {
    for (const size of ['micro', 'meta', 'aux', 'body', 'lead', 'subj']) {
      const out = cn(`text-${size} text-ink-fg`)
      expect(out).toContain(`text-${size}`)
      expect(out).toContain('text-ink-fg')
    }
  })

  test('size-vs-size still merges (last wins)', () => {
    expect(cn('text-micro text-meta')).toBe('text-meta')
  })

  test('color-vs-color still merges (last wins)', () => {
    expect(cn('text-ink-fg-1 text-coral')).toBe('text-coral')
  })

  test('ordinary tailwind conflict resolution is unaffected', () => {
    expect(cn('px-2 px-4')).toBe('px-4')
  })
})
