// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest'

import {
  COMPOSE_LINE_HEIGHT_ATTR,
  normalizeEditableEmailHtml,
  serializeEmailComposerHtml,
  stripComposeLineHeightWrapper
} from '../../src/shared/lib/emailComposerHtml'
import { sanitizeEmailHtml } from '../../src/shared/lib/emailSanitize'
import { splitQuoteHtml } from '../../src/shared/lib/quoteSplit'
import { COMPOSE_LINE_HEIGHT_DEFAULT } from '../../src/shared/state/appearance'

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

// 行距所见即所得: 编辑区行距来自 app CSS (从不随邮件发出), 不内联进出站 HTML 的话
// 收件端只能回落到客户端默认 (≈1.2) —— 这是本批修复的本体。
describe('serializeEmailComposerHtml — 行距注入', () => {
  test('未传 lineHeight 也注入 wrapper (默认值 = COMPOSE_LINE_HEIGHT_DEFAULT)', () => {
    const output = serializeEmailComposerHtml('<p>正文A</p>')
    expect(output).toContain(`${COMPOSE_LINE_HEIGHT_ATTR}="${COMPOSE_LINE_HEIGHT_DEFAULT}"`)
    expect(output).toContain(`line-height:${COMPOSE_LINE_HEIGHT_DEFAULT}`)
    expect(output).toContain('正文A')
  })

  test('显式 lineHeight 数值原样注入 (属性 + 内联样式两处)', () => {
    const output = serializeEmailComposerHtml('<p>正文B</p>', { lineHeight: 1.75 })
    expect(output).toContain(`${COMPOSE_LINE_HEIGHT_ATTR}="1.75"`)
    expect(output).toContain('line-height:1.75')
    expect(output).not.toContain('line-height:1.5')
  })

  test('顶层 <p> 内联块间距 (邮件客户端默认 1em margin 会和编辑区对不上)', () => {
    const output = serializeEmailComposerHtml('<p>段一</p><p>段二</p>')
    // CSSOM 会把 `0` 规范成 `0px`, 两种写法等价 —— 断言容忍两者。
    expect(output.match(/margin:\s*0(?:px)? 0(?:px)? 12px/g)).toHaveLength(2)
  })

  test('段落自带 margin (粘贴进来的外部 HTML) 不被覆盖', () => {
    const output = serializeEmailComposerHtml('<p style="margin: 4px 0">自带间距</p>')
    expect(output).toContain('margin: 4px 0')
    expect(output).not.toMatch(/margin:\s*0(?:px)? 0(?:px)? 12px/)
  })

  test('阅读区 sanitize 不剥行距内联样式 (自家详情 iframe 才能显示同一行距)', () => {
    // EmailBodyFrame 用同一套 EMAIL_PURIFY_OPTS 消毒。iframe 的 BODY_CSS 只在 body
    // 上设 `line-height: var(--ma-body-lh, 1.15)` 且无 !important, 元素自身的内联
    // 声明恒压过继承值 → 收到自己发的信, 阅读区显示的就是撰写时的行距。
    const sent = serializeEmailComposerHtml('<p>自己发给自己</p>', { lineHeight: 1.5 })
    const rendered = sanitizeEmailHtml(sent)
    expect(rendered).toContain('line-height:1.5')
    expect(rendered).toContain(COMPOSE_LINE_HEIGHT_ATTR)
  })

  test('表格样式与行距 wrapper 共存 (wrapper 不吃掉 Outlook 兼容属性)', () => {
    const output = serializeEmailComposerHtml('<table><tr><td>格</td></tr></table>', {
      lineHeight: 1.3
    })
    expect(output).toContain('line-height:1.3')
    expect(output).toContain('border="1"')
    expect(output).toContain('cellpadding="0"')
  })

  test('引用段拼在 wrapper 之后 (兄弟, 非嵌套) → 引用块字节不受行距影响', () => {
    const quote =
      '<div data-ma-quote="1"><hr><div>在 X 写道：</div><p style="color:#123456">原文Q</p></div>'
    // ComposePanel.getSanitizedHtml 的拼装顺序: 序列化新输入段, 再拼 sanitize 后的引用。
    const body = serializeEmailComposerHtml('<p>新写的</p>', { lineHeight: 1.75 })
    const sent = body + sanitizeEmailHtml(quote)
    // 引用段整体落在 wrapper 字节之外 (wrapper 已闭合), 不是被它包住。
    expect(sent.startsWith(body)).toBe(true)
    const quotePart = sent.slice(body.length)
    expect(quotePart).toContain('data-ma-quote="1"')
    // 引用块原文逐字保留 (sanitize 不改写 inline style)。
    expect(quotePart).toContain('color:#123456')
    // 引用段内不含行距标记 (只有新输入段那一层 wrapper 带)。
    expect(quotePart).not.toContain(COMPOSE_LINE_HEIGHT_ATTR)
    expect(quotePart).not.toContain('line-height')
  })
})

describe('stripComposeLineHeightWrapper — 草稿往返防嵌套', () => {
  test('剥掉自己注入的 wrapper 并回读行距值', () => {
    const wrapped = serializeEmailComposerHtml('<p>回填正文</p>', { lineHeight: 1.3 })
    const { html, lineHeight } = stripComposeLineHeightWrapper(wrapped)
    expect(lineHeight).toBe(1.3)
    expect(html).toContain('回填正文')
    expect(html).not.toContain(COMPOSE_LINE_HEIGHT_ATTR)
  })

  test('非本工具产出的 HTML 原样返回 (不做猜测性改写)', () => {
    for (const html of ['<p>外部客户端草稿</p>', '<div>用户自己的 div</div><p>尾随</p>', '']) {
      expect(stripComposeLineHeightWrapper(html)).toEqual({ html, lineHeight: null })
    }
  })

  test('发送→存草稿→再编辑→再发送: 恒只有一层 wrapper, 行距不漂移', () => {
    const first = serializeEmailComposerHtml('<p>初稿</p>', { lineHeight: 1.75 })
    const draft = first + sanitizeEmailHtml('<div data-ma-quote="1"><p>引用段</p></div>')

    // draft-edit 回填: 先按 marker 拆分, 回复段进 TipTap 前剥 wrapper。
    const { reply, quote } = splitQuoteHtml(draft)
    const restored = stripComposeLineHeightWrapper(reply)
    expect(restored.lineHeight).toBe(1.75)
    expect(restored.html).not.toContain(COMPOSE_LINE_HEIGHT_ATTR)

    // 再次发送: 用回填出来的行距重新序列化。
    const second =
      serializeEmailComposerHtml(restored.html, { lineHeight: restored.lineHeight ?? undefined }) +
      sanitizeEmailHtml(quote ?? '')
    expect(second.match(new RegExp(COMPOSE_LINE_HEIGHT_ATTR, 'g'))).toHaveLength(1)
    expect(second).toContain(`${COMPOSE_LINE_HEIGHT_ATTR}="1.75"`)
    expect(second).toContain('初稿')
    expect(second).toContain('引用段')
    expect(second).toContain('data-ma-quote="1"')
  })
})
