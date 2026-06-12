// Sprint Immersive-Translate — html-extractor run selection contract.
//
// 不测 node-html-parser 自己；只测我们的 run 划分 / filter / dedupe / 拆长段
// 逻辑 + id 稳定性。

import { describe, expect, test } from 'vitest'

import { MAX_LEN } from '../../src/shared/lib/translation_blocks'
import { extractBlocks } from '../../src/electron/main/lib/html-extractor'

describe('extractBlocks', () => {
  test('returns empty for empty / non-string input', () => {
    expect(extractBlocks('')).toEqual([])
    // @ts-expect-error — runtime guard
    expect(extractBlocks(null)).toEqual([])
    // @ts-expect-error — runtime guard
    expect(extractBlocks(undefined)).toEqual([])
  })

  test('picks up p / li / h* / td / blockquote / dt / dd in document order', () => {
    const html = `
      <h1>Heading One</h1>
      <p>First paragraph here.</p>
      <ul>
        <li>List item alpha</li>
        <li>List item bravo</li>
      </ul>
      <blockquote>Quoted text contains enough chars</blockquote>
      <table><tr><td>Cell with text</td></tr></table>
      <dl><dt>Term defined</dt><dd>Definition explained</dd></dl>
    `
    const blocks = extractBlocks(html)
    expect(blocks.map((b) => b.text)).toEqual([
      'Heading One',
      'First paragraph here.',
      'List item alpha',
      'List item bravo',
      'Quoted text contains enough chars',
      'Cell with text',
      'Term defined',
      'Definition explained'
    ])
  })

  test('skips short text (< 4 chars)', () => {
    const html = '<p>Hi</p><p>Hi!</p><p>Long enough sentence.</p>'
    const blocks = extractBlocks(html)
    expect(blocks.map((b) => b.text)).toEqual(['Long enough sentence.'])
  })

  test('skips CJK-heavy paragraphs (already Chinese / Japanese / Korean)', () => {
    const html = `
      <p>这是一段中文文字，应该被跳过。</p>
      <p>これは日本語の段落です、スキップされるべき。</p>
      <p>이것은 한국어 단락입니다 스킵되어야 합니다.</p>
      <p>This English line should survive.</p>
      <p>Mixed 中文 with English half-and-half but still mostly English here.</p>
    `
    const blocks = extractBlocks(html)
    const texts = blocks.map((b) => b.text)
    expect(texts).toContain('This English line should survive.')
    expect(texts).toContain('Mixed 中文 with English half-and-half but still mostly English here.')
    expect(texts.some((t) => t.startsWith('这是一段'))).toBe(false)
    expect(texts.some((t) => t.startsWith('これは'))).toBe(false)
    expect(texts.some((t) => t.startsWith('이것은'))).toBe(false)
  })

  test('skips text inside <pre> / <script> / <style>', () => {
    const html = `
      <p>Real paragraph one.</p>
      <pre><code>const x = 'do not translate me';</code></pre>
      <p>Real paragraph two.</p>
      <style>p { color: red; }</style>
      <script>console.log('skip me');</script>
    `
    const blocks = extractBlocks(html)
    expect(blocks.map((b) => b.text)).toEqual(['Real paragraph one.', 'Real paragraph two.'])
  })

  test('dedupes identical trimmed text', () => {
    const html = `
      <p>Same sentence repeats here.</p>
      <p>Same sentence repeats here.</p>
      <p>Different sentence appears now.</p>
    `
    const blocks = extractBlocks(html)
    expect(blocks.map((b) => b.text)).toEqual([
      'Same sentence repeats here.',
      'Different sentence appears now.'
    ])
  })

  test('id is stable across runs for the same DOM path', () => {
    const html = '<div><p>First paragraph here is long enough.</p><p>Second one too.</p></div>'
    const a = extractBlocks(html)
    const b = extractBlocks(html)
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id))
    for (const blk of a) {
      expect(blk.id).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  test('id differs for different positions of same text', () => {
    const a = extractBlocks('<div><p>Unique paragraph alpha here.</p></div>')
    const b = extractBlocks('<section><p>Unique paragraph alpha here.</p></section>')
    expect(a[0]?.id).not.toEqual(b[0]?.id)
  })

  test('collapses internal whitespace + newlines into single spaces', () => {
    const html = `
      <p>Line one
         spans multiple
         physical    lines.</p>
    `
    const blocks = extractBlocks(html)
    expect(blocks[0]?.text).toBe('Line one spans multiple physical lines.')
  })

  test('splits paragraphs over the 800-char max-length cap instead of dropping them', () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} keeps enough English words.`
    ).join(' ')
    expect(long.length).toBeGreaterThan(MAX_LEN)
    const html = `<p>${long}</p><p>Short enough paragraph here.</p>`
    const blocks = extractBlocks(html)
    const longChunks = blocks.filter(
      (b) => b.text.startsWith('Sentence') || b.text.includes('Sentence')
    )
    expect(longChunks.length).toBeGreaterThan(1)
    expect(longChunks.every((b) => b.text.length <= MAX_LEN)).toBe(true)
    expect(longChunks.map((b) => b.text).join(' ')).toBe(long)
    expect(blocks.map((b) => b.text)).toContain('Short enough paragraph here.')
  })

  test('extracts direct mixed-content text before nested blocks', () => {
    const html = '<div>On Wed, Cole wrote:<p>Nested reply paragraph here.</p></div>'
    expect(extractBlocks(html).map((b) => b.text)).toEqual([
      'On Wed, Cole wrote:',
      'Nested reply paragraph here.'
    ])
  })

  test('double br splits runs while single br stays in one run', () => {
    const html = `
      <div>First line<br><br>Second line</div>
      <div>Single br line<br>continues here</div>
    `
    expect(extractBlocks(html).map((b) => b.text)).toEqual([
      'First line',
      'Second line',
      'Single br line continues here'
    ])
  })

  test('extracts th / center / font container text', () => {
    const html = `
      <table><tr><th>Header cell text</th></tr></table>
      <center>Centered announcement text</center>
      <div><font>Legacy font wrapped text</font></div>
    `
    expect(extractBlocks(html).map((b) => b.text)).toEqual([
      'Header cell text',
      'Centered announcement text',
      'Legacy font wrapped text'
    ])
  })

  test('skips display none / aria hidden text', () => {
    const html = `
      <div style="display: none">Hidden preheader text</div>
      <div aria-hidden="true">Hidden aria text</div>
      <p>Visible English paragraph.</p>
    `
    expect(extractBlocks(html).map((b) => b.text)).toEqual(['Visible English paragraph.'])
  })

  test('skips URL-only, email-only, and numeric/symbol-only runs', () => {
    const html = `
      <p>https://example.com/path</p>
      <p>person@example.com</p>
      <p>12345 !!! ???</p>
      <p>Normal English sentence survives.</p>
    `
    expect(extractBlocks(html).map((b) => b.text)).toEqual(['Normal English sentence survives.'])
  })

  test('skips a run that is only one code element but keeps inline code in a sentence', () => {
    const html = `
      <div><code>const token = value</code></div>
      <p>Please run <code>npm install</code> before continuing.</p>
    `
    expect(extractBlocks(html).map((b) => b.text)).toEqual([
      'Please run npm install before continuing.'
    ])
  })

  test('handles real-world malformed email html (unclosed tags) without crashing', () => {
    const html = '<p>First <b>bold paragraph here.<p>Second one (unclosed b).'
    const blocks = extractBlocks(html)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]?.text.length).toBeGreaterThanOrEqual(4)
  })
})
