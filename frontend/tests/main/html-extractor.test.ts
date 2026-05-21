// Sprint Immersive-Translate — html-extractor block selection contract.
//
// 不测 node-html-parser 自己; 只测我们的 filter / dedupe / CJK skip / ancestor
// skip 逻辑 + id 稳定性。

import { describe, expect, test } from 'vitest'

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
    const texts = blocks.map((b) => b.text)
    expect(texts).toEqual([
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
    // 全 CJK 段落都被跳了
    expect(texts.some((t) => t.startsWith('这是一段'))).toBe(false)
    expect(texts.some((t) => t.startsWith('これは'))).toBe(false)
    expect(texts.some((t) => t.startsWith('이것은'))).toBe(false)
  })

  test('skips text inside <code> / <pre> / <script> / <style>', () => {
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
    // ids should be 8 hex chars
    for (const blk of a) {
      expect(blk.id).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  test('id differs for different positions of same text', () => {
    // Two p elements with different paths → different ids even if text is the
    // same. (Dedupe step still drops one, but the picked one's id must reflect
    // its position uniquely if we later add the other back.)
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

  test('drops paragraphs over the 800-char max-length cap', () => {
    const long = 'word '.repeat(200) // 1000 chars
    const html = `<p>${long}</p><p>Short enough paragraph here.</p>`
    const blocks = extractBlocks(html)
    expect(blocks.map((b) => b.text)).toEqual(['Short enough paragraph here.'])
  })

  test('handles real-world malformed email html (unclosed tags) without crashing', () => {
    const html = '<p>First <b>bold paragraph here.<p>Second one (unclosed b).'
    const blocks = extractBlocks(html)
    // Doesn't crash; gets at least one of them
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]?.text.length).toBeGreaterThanOrEqual(4)
  })
})
