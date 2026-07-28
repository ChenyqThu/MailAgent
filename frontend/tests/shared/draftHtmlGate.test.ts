// @vitest-environment happy-dom
//
// Composer v2 富文本兼容门：标准 table 已由 TableKit 表达；Office 样式可清洗后编辑；
// nested/layout table、cid/VML/条件注释仍走保真 iframe。
// 保守原则: 拿不准一律 complex (宁可不可行内编辑, 不可发出去变纯文本)。

import { describe, expect, test } from 'vitest'

import { assessDraftHtml, classifyDraftHtml } from '../../src/shared/lib/draftHtmlGate'

describe('classifyDraftHtml — empty', () => {
  test('null / undefined / 空串 / 纯空白 → empty', () => {
    expect(classifyDraftHtml(null)).toBe('empty')
    expect(classifyDraftHtml(undefined)).toBe('empty')
    expect(classifyDraftHtml('')).toBe('empty')
    expect(classifyDraftHtml('   \n\t ')).toBe('empty')
  })
})

describe('classifyDraftHtml — simple (TipTap 可表达)', () => {
  test('纯文本段落', () => {
    expect(classifyDraftHtml('<p>hello world</p>')).toBe('simple')
  })

  test('TipTap 自产富文本 (加粗/列表/链接/inline style)', () => {
    const html =
      '<p><strong>bold</strong> <em>it</em> <span style="color: #ff0000">red</span></p>' +
      '<ul><li><p>a</p></li><li><p>b</p></li></ul>' +
      '<blockquote><p>quote</p></blockquote>' +
      '<p><a href="https://example.com">link</a></p>'
    expect(classifyDraftHtml(html)).toBe('simple')
  })

  test('http(s)/data: 图片可进编辑器 (Image extension 兜住)', () => {
    expect(classifyDraftHtml('<p><img src="https://x.test/a.png" alt=""></p>')).toBe('simple')
    expect(classifyDraftHtml('<p><img src="data:image/png;base64,iVBOR"></p>')).toBe('simple')
  })

  test('标准 table 由 TableKit 表达, 不再整块折叠', () => {
    const html = '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>'
    expect(assessDraftHtml(html)).toEqual({ compatibility: 'editable', html })
    expect(classifyDraftHtml(html)).toBe('simple')
  })

  test('Office table 清除 mso/class 后进入 normalize-editable', () => {
    const html =
      '<style>.x{mso-padding-alt:0}</style><table class="MsoTableGrid" style="mso-cellspacing:0"><tr><td colspan="2">A</td></tr></table>'
    const result = assessDraftHtml(html)
    expect(result.compatibility).toBe('normalize-editable')
    expect(result.html).toContain('<table')
    expect(result.html).toContain('colspan="2"')
    expect(result.html).not.toMatch(/mso-|MsoTableGrid|<style/i)
  })
})

describe('classifyDraftHtml — complex (保真通路)', () => {
  test('nested table / role=presentation 布局表', () => {
    const nested = '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>'
    expect(assessDraftHtml(nested).compatibility).toBe('preserve-only')
    expect(classifyDraftHtml('<table role="presentation"><tr><td>x</td></tr></table>')).toBe(
      'complex'
    )
  })

  test('cid: 内联图引用', () => {
    expect(classifyDraftHtml('<p><img src="cid:image001@01DC"></p>')).toBe('complex')
  })

  test('相对路径图 (库内 cid 改写成 attachments/{id}/{file})', () => {
    expect(classifyDraftHtml('<p><img src="attachments/42/logo.png"></p>')).toBe('complex')
  })

  test('普通 mso 样式可规范化, VML / 条件注释仍保真', () => {
    expect(assessDraftHtml('<p style="mso-line-height:100%">x</p>').compatibility).toBe(
      'normalize-editable'
    )
    expect(classifyDraftHtml('<v:shape id="s1"></v:shape>')).toBe('complex')
    expect(classifyDraftHtml('<!--[if mso]><p>x</p><![endif]-->')).toBe('complex')
    expect(classifyDraftHtml('<div xmlns:v="urn:schemas-microsoft-com:vml">x</div>')).toBe(
      'complex'
    )
  })

  test('iframe/svg 等 schema 无对应 node 的结构', () => {
    expect(classifyDraftHtml('<iframe src="https://x.test"></iframe>')).toBe('complex')
    expect(classifyDraftHtml('<svg viewBox="0 0 1 1"></svg>')).toBe('complex')
  })

  test('超深嵌套 (邮件客户端布局汤)', () => {
    const deep = `${'<div>'.repeat(12)}text${'</div>'.repeat(12)}`
    expect(classifyDraftHtml(deep)).toBe('complex')
  })

  test('浅嵌套不误伤 (TipTap 嵌套列表深度以内)', () => {
    const shallow = '<div><ul><li><ul><li><p>deep list</p></li></ul></li></ul></div>'
    expect(classifyDraftHtml(shallow)).toBe('simple')
  })
})
