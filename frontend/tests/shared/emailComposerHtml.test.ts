// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest'

import {
  normalizeEditableEmailHtml,
  serializeEmailComposerHtml
} from '../../src/shared/lib/emailComposerHtml'

describe('normalizeEditableEmailHtml', () => {
  test('preserves table structure while removing Office-only markup', () => {
    const html =
      '<style>.grid{mso-cellspacing:0}</style>' +
      '<table class="MsoTableGrid" style="mso-padding-alt:0; color: red" onclick="x()">' +
      '<tr><td rowspan="2">A</td><td><o:p>B</o:p></td></tr><tr><td>C</td></tr></table>'
    const output = normalizeEditableEmailHtml(html)

    expect(output).toContain('<table')
    expect(output).toContain('rowspan="2"')
    expect(output).toContain('B')
    expect(output).not.toMatch(/Mso|mso-|onclick|<style|<o:p/i)
  })
})

describe('serializeEmailComposerHtml', () => {
  test('adds conservative Outlook-compatible table attributes and inline styles', () => {
    const output = serializeEmailComposerHtml(
      '<table class="compose-email-table"><tbody><tr><th>H</th><td>A</td></tr></tbody></table>'
    )

    expect(output).toContain('border="1"')
    expect(output).toContain('cellpadding="0"')
    expect(output).toContain('cellspacing="0"')
    expect(output).toContain('border-collapse: collapse')
    expect(output).toContain('padding: 6px 8px')
    expect(output).toContain('background-color: #f3f4f6')
    expect(output).not.toContain('compose-email-table')
  })

  test('sanitizes unsafe attributes and elements before export', () => {
    const output = serializeEmailComposerHtml(
      '<table onclick="alert(1)"><tr><td><script>alert(1)</script>safe</td></tr></table>'
    )
    expect(output).toContain('safe')
    expect(output).not.toMatch(/onclick|script|alert/i)
  })
})
