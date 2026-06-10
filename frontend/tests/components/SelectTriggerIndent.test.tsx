// @vitest-environment happy-dom
//
// Regression — collapsed Select value "phantom indent" (v0.6.2 真机 bug).
//
// ROOT CAUSE (verified in real chromium, not reproducible in jsdom/happy-dom
// because neither lays out CSS): a <button> carries the UA default
// `text-align:center`. The SelectValue <span> is a flex item that the trigger's
// `[&>span]:line-clamp-1` rule turns into a block box (display:flow-root), and
// flex can size that box WIDER than its glyphs. When the box outgrows the text,
// the inherited center alignment leaves equal left/right gaps — read as an
// "indent" on the collapsed value — but ONLY for values long enough to make the
// flex box exceed its text width (short values get a tight box → no gap). That
// is exactly why LLM_MODEL='claude-opus-4-8[1m]' (long) showed it while
// LLM_FALLBACK_MODELS='gpt-5.5' (short) did not.
//
// Chromium measurement (range vs span boxes), before fix:
//   long value  glyphLeft offset within span = 17.55px   (centered → indented)
//   short value glyphLeft offset within span =  0.00px
// After adding `text-left` to SelectTrigger:
//   both values glyphLeft offset = 0.00px
//
// jsdom can't measure glyph boxes, so the regression is locked at the CSS
// contract level: the trigger MUST carry `text-left` so the value pins
// flush-left regardless of value length.
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../src/shared/components/ui/select'

afterEach(cleanup)

function renderSelect(value: string) {
  return render(
    <Select value={value} onValueChange={() => {}}>
      <SelectTrigger>
        <SelectValue placeholder="pick" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude-opus-4-8[1m]">claude-opus-4-8[1m]</SelectItem>
        <SelectItem value="gpt-5.5">gpt-5.5</SelectItem>
      </SelectContent>
    </Select>
  )
}

describe('SelectTrigger collapsed-value indent regression', () => {
  test('trigger pins value left (text-left) to defeat <button> UA center-align', () => {
    renderSelect('claude-opus-4-8[1m]')
    const trigger = screen.getByRole('combobox')
    // The load-bearing fix: without `text-left`, the inherited <button>
    // center-align indents long values inside an over-wide flex box.
    expect(trigger.className).toContain('text-left')
  })

  test('collapsed trigger renders the selected value as a single flush text node', () => {
    // Whether the value is the first long option or the short one, the value
    // span holds exactly one text node — no padding/indent/wrapper that would
    // visually offset it (the offset came purely from center-align + box width).
    for (const v of ['claude-opus-4-8[1m]', 'gpt-5.5']) {
      const { unmount } = renderSelect(v)
      const span = screen.getByRole('combobox').querySelector('span')
      expect(span?.childNodes.length).toBe(1)
      expect(span?.textContent).toBe(v)
      unmount()
    }
  })
})
