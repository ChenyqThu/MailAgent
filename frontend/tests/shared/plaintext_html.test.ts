import { describe, expect, test } from 'vitest'

import { plaintextToHtml } from '../../src/shared/lib/plaintext_html'

describe('plaintextToHtml', () => {
  test('escapes HTML special characters', () => {
    expect(plaintextToHtml(`Tom & <tag> "quote" 'apostrophe'`)).toBe(
      '<p>Tom &amp; &lt;tag&gt; &quot;quote&quot; &#39;apostrophe&#39;</p>'
    )
  })

  test('splits paragraphs on blank lines', () => {
    expect(plaintextToHtml('First paragraph.\n\nSecond paragraph.')).toBe(
      '<p>First paragraph.</p><p>Second paragraph.</p>'
    )
  })

  test('converts single newlines inside a paragraph to br', () => {
    expect(plaintextToHtml('Line one\nLine two')).toBe('<p>Line one<br>Line two</p>')
  })

  test('trims leading and trailing whitespace', () => {
    expect(plaintextToHtml(' \n  Hello world.  \n ')).toBe('<p>Hello world.</p>')
  })

  test('returns empty string for empty input', () => {
    expect(plaintextToHtml('')).toBe('')
    expect(plaintextToHtml(' \n\t ')).toBe('')
  })

  test('normalizes CRLF line endings', () => {
    expect(plaintextToHtml('Alpha\r\nBravo\r\n\r\nCharlie')).toBe(
      '<p>Alpha<br>Bravo</p><p>Charlie</p>'
    )
  })
})
