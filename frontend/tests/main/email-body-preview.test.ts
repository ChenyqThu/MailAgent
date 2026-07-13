import { describe, expect, test } from 'vitest'
import { parse } from 'node-html-parser'

import { previewHtml } from '../../src/electron/main/lib/email-body-preview'

describe('previewHtml', () => {
  test('keeps balanced element boundaries when truncating nested HTML', () => {
    const html = `<section><p>${'A'.repeat(80)}</p><p>tail</p></section>`
    const preview = previewHtml(html, 32)
    const parsed = parse(preview)
    expect(parsed.querySelectorAll('section')).toHaveLength(1)
    expect(parsed.querySelectorAll('p')).toHaveLength(1)
    expect(parsed.text).toHaveLength(32)
    expect(preview).toContain('</p></section>')
  })

  test('preserves void elements without corrupting their attributes', () => {
    const preview = previewHtml(`<p>hello<img src="cid:x">${'B'.repeat(80)}</p>`, 16)
    expect(preview).toContain('<img src="cid:x">')
    expect(parse(preview).querySelector('img')?.getAttribute('src')).toBe('cid:x')
  })
})
