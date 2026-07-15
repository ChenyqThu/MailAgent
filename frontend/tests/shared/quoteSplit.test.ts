// @vitest-environment happy-dom
//
// D2 Bug B — splitQuoteHtml (data-ma-quote marker 拆分) + sanitize 保 marker 回归锁:
//   - 有 marker → reply / quote 两段; marker 元素及其后兄弟节点全归 quote。
//   - 无 marker / marker 只是文本字样 → quote=null (调用方回退现状全量分流)。
//   - 多 marker 取首个; 嵌套 wrapper 防御。
//   - 🔴 sanitizeEmailHtml (EMAIL_PURIFY_OPTS) 不得剥 data-ma-quote —— 发送拼回
//     链路靠它保住 marker (后端 reconcile 再拆分同一契约)。

import { describe, expect, test } from 'vitest'

import { QUOTE_MARKER_ATTR, splitQuoteHtml } from '../../src/shared/lib/quoteSplit'
import { sanitizeEmailHtml } from '../../src/shared/lib/emailSanitize'

const QUOTE_BLOCK =
  '<div data-ma-quote="1"><p>在 2026年7月8日，A &lt;a@x.com&gt; 写道：</p>' +
  '<blockquote>原引用内容Q1</blockquote></div>'

describe('splitQuoteHtml — marker 拆分', () => {
  test('reply + marker 引用块 → 两段切分', () => {
    const html = `<p>回复正文R1</p>${QUOTE_BLOCK}`
    const { reply, quote } = splitQuoteHtml(html)
    expect(reply).toContain('回复正文R1')
    expect(reply).not.toContain('原引用内容Q1')
    expect(quote).not.toBeNull()
    expect(quote).toContain(QUOTE_MARKER_ATTR)
    expect(quote).toContain('原引用内容Q1')
  })

  test('marker 之后的兄弟节点 (尾随内容) 一并归 quote', () => {
    const html = `<p>R2</p>${QUOTE_BLOCK}<p>尾随T2</p>`
    const { reply, quote } = splitQuoteHtml(html)
    expect(reply).not.toContain('尾随T2')
    expect(quote).toContain('尾随T2')
  })

  test('reply 为空 (纯引用草稿) → reply 空串, quote 全量', () => {
    const { reply, quote } = splitQuoteHtml(QUOTE_BLOCK)
    expect(reply.trim()).toBe('')
    expect(quote).toContain('原引用内容Q1')
  })

  test('多个 marker → 取文档序首个, 后续随兄弟一并归 quote', () => {
    const html =
      '<p>R3</p><div data-ma-quote="1"><p>第一段Q3a</p></div>' +
      '<div data-ma-quote="1"><p>第二段Q3b</p></div>'
    const { reply, quote } = splitQuoteHtml(html)
    expect(reply).toContain('R3')
    expect(quote).toContain('第一段Q3a')
    expect(quote).toContain('第二段Q3b')
  })

  test('marker 被 wrapper 嵌套 → 按 marker 所在层级切分 (防御)', () => {
    const html = `<div><p>R4</p>${QUOTE_BLOCK}</div>`
    const { reply, quote } = splitQuoteHtml(html)
    expect(reply).toContain('R4')
    expect(reply).not.toContain('原引用内容Q1')
    expect(quote).toContain('原引用内容Q1')
  })
})

describe('splitQuoteHtml — 无 marker 回退', () => {
  test('普通草稿 HTML → quote=null, reply 原样', () => {
    const html = '<p>hello</p><blockquote>plain quote</blockquote>'
    const { reply, quote } = splitQuoteHtml(html)
    expect(quote).toBeNull()
    expect(reply).toBe(html)
  })

  test('空串 → quote=null', () => {
    expect(splitQuoteHtml('').quote).toBeNull()
  })

  test('marker 只是正文文本字样 (非元素属性) → 不切', () => {
    const html = '<p>代码示例: data-ma-quote 属性</p>'
    const { reply, quote } = splitQuoteHtml(html)
    expect(quote).toBeNull()
    expect(reply).toBe(html)
  })
})

describe('sanitize 保 marker (发送拼回链路回归锁)', () => {
  test('sanitizeEmailHtml (EMAIL_PURIFY_OPTS) 不剥 data-ma-quote 属性', () => {
    const out = sanitizeEmailHtml(QUOTE_BLOCK)
    expect(out).toContain('data-ma-quote')
    expect(out).toContain('原引用内容Q1')
  })

  test('sanitize 后再 split 仍可切分 (roundtrip)', () => {
    const html = sanitizeEmailHtml(`<p>回复R5</p>${QUOTE_BLOCK}`)
    const { reply, quote } = splitQuoteHtml(html)
    expect(reply).toContain('回复R5')
    expect(quote).not.toBeNull()
    expect(quote).toContain('原引用内容Q1')
  })
})
