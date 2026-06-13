import { type HTMLElement, parse } from 'node-html-parser'
import { describe, expect, test } from 'vitest'

import {
  collectRuns,
  type DomAdapter,
  isCjkHeavy,
  isTranslatableText,
  MAX_LEN,
  normalizeForMatch,
  splitLongText
} from '../../src/shared/lib/translation_blocks'

type HtmlNode = HTMLElement | HTMLElement['childNodes'][number]

const adapter: DomAdapter<HtmlNode> = {
  isElement(node) {
    return node.nodeType === 1
  },
  isText(node) {
    return node.nodeType === 3
  },
  tagName(node) {
    const tag = (node as HTMLElement).tagName
    return typeof tag === 'string' ? tag.toLowerCase() : ''
  },
  childNodes(node) {
    return Array.from(node.childNodes ?? []) as HtmlNode[]
  },
  getAttribute(node, name) {
    if (node.nodeType !== 1) return undefined
    return (node as HTMLElement).getAttribute(name)
  },
  textOf(node) {
    return node.text ?? node.textContent ?? ''
  }
}

function runsOf(html: string) {
  return collectRuns(adapter, parse(html) as HtmlNode)
}

describe('collectRuns', () => {
  test('splits direct inline runs around nested block elements', () => {
    const runs = runsOf(
      '<div>On Wed, Cole wrote:<p>Nested reply paragraph here.</p>Footer note</div>'
    )
    expect(runs.map((r) => r.text)).toEqual([
      'On Wed, Cole wrote:',
      'Nested reply paragraph here.',
      'Footer note'
    ])
  })

  test('keeps inline tags in the parent run and treats center/th as containers', () => {
    const runs = runsOf(`
      <div>Hello <span>inline</span> <font>font text</font></div>
      <center>Centered text here</center>
      <table><tr><th>Header cell here</th></tr></table>
    `)
    expect(runs.map((r) => r.text)).toEqual([
      'Hello inline font text',
      'Centered text here',
      'Header cell here'
    ])
  })

  test('double br breaks a run but single br does not', () => {
    const runs = runsOf('<div>Alpha line<br><br>Bravo line<br>continues</div>')
    expect(runs.map((r) => r.text)).toEqual(['Alpha line', 'Bravo line continues'])
  })

  test('prunes skipped and explicitly hidden subtrees', () => {
    const runs = runsOf(`
      <div>Visible before<script>hidden()</script> visible after</div>
      <div style="visibility: hidden">Invisible text</div>
      <div hidden>Hidden attribute text</div>
      <p aria-hidden="true">Aria hidden text</p>
      <p>Final visible text</p>
    `)
    expect(runs.map((r) => r.text)).toEqual(['Visible before visible after', 'Final visible text'])
  })

  test('marks a run made only from one code element', () => {
    const [codeOnly, sentence] = runsOf(
      '<div><code>const value = token</code></div><p>Use <code>npm test</code> today.</p>'
    )
    expect(codeOnly?.isSingleCodeElement).toBe(true)
    expect(sentence?.isSingleCodeElement).toBe(false)
  })
})

describe('splitLongText', () => {
  test('does not split text at exactly 800 chars', () => {
    const exact = 'a'.repeat(MAX_LEN)
    expect(splitLongText(exact)).toEqual([exact])
  })

  test('splits greedily on sentence boundaries', () => {
    const sentence = 'This sentence has enough words.'
    const text = Array.from({ length: 40 }, () => sentence).join(' ')
    const chunks = splitLongText(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= MAX_LEN)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
  })

  test('hard-cuts a single overlong sentence', () => {
    const text = 'a'.repeat(MAX_LEN + 5)
    expect(splitLongText(text).map((chunk) => chunk.length)).toEqual([MAX_LEN, 5])
  })
})

describe('isTranslatableText', () => {
  test('normalizes fuzzy match text', () => {
    expect(normalizeForMatch('  Hello\nWORLD  ')).toBe('hello world')
  })

  test('detects CJK-heavy text with whitespace excluded from denominator', () => {
    expect(isCjkHeavy('中文 中文 text')).toBe(true)
    expect(isCjkHeavy('English 中文 words stay mostly English')).toBe(false)
  })

  test('accepts ordinary English text', () => {
    expect(isTranslatableText('Normal English sentence.')).toBe(true)
  })

  test('rejects short, CJK-heavy, no-letter, URL, email, and single-code runs', () => {
    expect(isTranslatableText('Hi')).toBe(false)
    expect(isTranslatableText('这是一段中文内容')).toBe(false)
    expect(isTranslatableText('12345 !!!')).toBe(false)
    expect(isTranslatableText('https://example.com/path')).toBe(false)
    expect(isTranslatableText('person@example.com')).toBe(false)
    expect(isTranslatableText('const token = value', { isSingleCodeElement: true })).toBe(false)
  })
})
