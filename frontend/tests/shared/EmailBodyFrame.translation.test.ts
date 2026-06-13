// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest'

import { injectTranslations } from '../../src/shared/components/email/emailTranslationInjection'
import type { TranslationSegment } from '../../src/shared/api/types'

function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument('mail')
  doc.body.innerHTML = html
  return doc
}

function seg(src: string, tgt: string): TranslationSegment {
  return { src, tgt }
}

function injected(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll('.mailagent-translation')) as HTMLElement[]
}

describe('injectTranslations', () => {
  test('injects a basic translation into the matched run container', () => {
    const doc = makeDoc('<p>Hello world paragraph.</p>')
    expect(injectTranslations(doc, [seg('Hello world paragraph.', '你好，世界段落。')])).toBe(1)
    const p = doc.querySelector('p')!
    const div = p.lastElementChild as HTMLElement
    expect(div.className).toBe('mailagent-translation')
    expect(div.textContent).toBe('你好，世界段落。')
  })

  test('injects mixed-content translation immediately after the run end node', () => {
    const doc = makeDoc(
      '<div id="wrap">On Wed, <span>Cole wrote:</span><p>Nested reply text.</p></div>'
    )
    expect(injectTranslations(doc, [seg('On Wed, Cole wrote:', '周三，Cole 写道：')])).toBe(1)
    const wrap = doc.getElementById('wrap')!
    const span = wrap.querySelector('span')!
    const div = wrap.querySelector('.mailagent-translation')!
    const nested = wrap.querySelector('p')!
    expect(div.previousSibling).toBe(span)
    expect(div.nextSibling).toBe(nested)
  })

  test('aggregates multiple chunks for the same run into one ordered div', () => {
    const doc = makeDoc('<p>Alpha sentence. Bravo sentence. Charlie sentence.</p>')
    expect(
      injectTranslations(doc, [seg('Bravo sentence.', '第二句'), seg('Alpha sentence.', '第一句')])
    ).toBe(1)
    const [div] = injected(doc)
    expect(div?.innerHTML).toBe('第一句<br>第二句')
  })

  test('injects the same exact source into all equal runs', () => {
    const doc = makeDoc(
      '<p>Repeated paragraph text.</p><blockquote>Repeated paragraph text.</blockquote>'
    )
    expect(injectTranslations(doc, [seg('Repeated paragraph text.', '重复段落。')])).toBe(2)
    expect(injected(doc).map((div) => div.textContent)).toEqual(['重复段落。', '重复段落。'])
  })

  test('old cross-run source cache injects only into the first matching run', () => {
    const doc = makeDoc('<p>First cached paragraph.</p><p>Second cached paragraph.</p>')
    expect(
      injectTranslations(doc, [
        seg('First cached paragraph. Second cached paragraph.', '旧缓存跨段译文。')
      ])
    ).toBe(1)
    expect(doc.querySelector('p')?.querySelector('.mailagent-translation')?.textContent).toBe(
      '旧缓存跨段译文。'
    )
    expect(doc.querySelectorAll('p')[1]?.querySelector('.mailagent-translation')).toBeNull()
  })

  test('clears previous translations before reinjecting', () => {
    const doc = makeDoc('<p>Hello world paragraph.</p>')
    expect(injectTranslations(doc, [seg('Hello world paragraph.', '第一次')])).toBe(1)
    expect(injectTranslations(doc, [seg('Hello world paragraph.', '第二次')])).toBe(1)
    expect(injected(doc)).toHaveLength(1)
    expect(injected(doc)[0]?.textContent).toBe('第二次')
  })

  test('escapes translation HTML before inserting', () => {
    const doc = makeDoc('<p>Hello world paragraph.</p>')
    injectTranslations(doc, [
      seg('Hello world paragraph.', '<img src=x onerror=alert(1)>& "quote"')
    ])
    const div = injected(doc)[0]!
    expect(div.querySelector('img')).toBeNull()
    expect(div.textContent).toBe('<img src=x onerror=alert(1)>& "quote"')
    expect(div.innerHTML).toContain('&lt;img')
  })
})
