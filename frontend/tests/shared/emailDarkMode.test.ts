// @vitest-environment happy-dom
//
// emailDarkMode — 深色主题邮件正文保色相亮度翻转的纯函数单测。
// 规则来源: frontend/src/shared/lib/emailDarkMode.ts 头注释。

import { describe, expect, it } from 'vitest'

import { adaptHtmlForDarkMode, flipDarkForeground, parseCssColor } from '@shared/lib/emailDarkMode'

// ── parseCssColor ──────────────────────────────────────────────────────

describe('parseCssColor', () => {
  it('parses hex forms', () => {
    expect(parseCssColor('#000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseCssColor('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseCssColor('#003366')).toEqual({ r: 0, g: 51, b: 102 })
    expect(parseCssColor('#00336680')).toEqual({ r: 0, g: 51, b: 102 })
  })

  it('parses rgb()/rgba() comma and space syntax', () => {
    expect(parseCssColor('rgb(0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('parses named colors incl. Outlook windowtext', () => {
    expect(parseCssColor('black')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseCssColor('WindowText')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseCssColor('navy')).toEqual({ r: 0, g: 0, b: 128 })
  })

  it('returns null for unparseable values (conservative skip)', () => {
    expect(parseCssColor('var(--x)')).toBeNull()
    expect(parseCssColor('inherit')).toBeNull()
    expect(parseCssColor('currentcolor')).toBeNull()
    expect(parseCssColor('rebeccapurple')).toBeNull() // 冷门 named 不收
    expect(parseCssColor('rgb(300, 0, 0)')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

// ── flipDarkForeground ─────────────────────────────────────────────────

function hueOf(rgbStr: string): number {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgbStr)!
  const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return h * 360
}

describe('flipDarkForeground', () => {
  it('flips black to near-white (L≈0.95)', () => {
    expect(flipDarkForeground('#000')).toBe('rgb(242, 242, 242)')
  })

  it('preserves hue: dark blue becomes LIGHT blue, not orange', () => {
    const out = flipDarkForeground('#003366') // H=210° 深蓝
    expect(out).not.toBeNull()
    expect(Math.abs(hueOf(out!) - 210)).toBeLessThan(2)
    // 翻转后必须显著变亮 (B 分量主导且 > 原值)
    const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(out!)!
    expect(Number(m[3])).toBeGreaterThan(150)
  })

  it('leaves light/medium colors untouched (authored light-on-dark)', () => {
    expect(flipDarkForeground('#ffffff')).toBeNull()
    expect(flipDarkForeground('#dddddd')).toBeNull()
    expect(flipDarkForeground('rgb(232, 234, 238)')).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(flipDarkForeground('var(--c)')).toBeNull()
  })
})

// ── adaptHtmlForDarkMode (DOM 集成) ────────────────────────────────────

describe('adaptHtmlForDarkMode', () => {
  it('flips dark inline color', () => {
    const out = adaptHtmlForDarkMode('<p style="color:#000">x</p>')
    expect(out).toContain('rgb(242, 242, 242)')
    expect(out).not.toContain('#000')
  })

  it('flips <font color> legacy attribute', () => {
    const out = adaptHtmlForDarkMode('<font color="black">x</font>')
    expect(out).toContain('color="rgb(242, 242, 242)"')
  })

  it('flips Outlook windowtext (font attr path)', () => {
    // style="color:windowtext" 走 CSSOM — happy-dom 不认 deprecated system
    // color 返回空串 (Chromium 真机认, CSS Color 4 deprecated-but-valid),
    // 故此用例走不经 CSSOM 的 <font color> 属性路径锁 windowtext 解析。
    const out = adaptHtmlForDarkMode('<font color="windowtext">x</font>')
    expect(out).toContain('color="rgb(242, 242, 242)"')
  })

  it('removes light backgrounds (style + bgcolor attr)', () => {
    const out = adaptHtmlForDarkMode(
      '<table bgcolor="#FFFFFF"><tr><td style="background-color:#f5f5f5">x</td></tr></table>'
    )
    expect(out).not.toContain('bgcolor')
    expect(out).not.toContain('#f5f5f5')
    expect(out).not.toContain('background-color')
  })

  it('keeps dark backgrounds AND skips foreground flip inside that subtree', () => {
    const html =
      '<div style="background-color:#1a1a2e">' +
      '<span style="color:#111111">authored dark-on-dark</span>' +
      '</div>' +
      '<p style="color:#111111">outside</p>'
    const out = adaptHtmlForDarkMode(html)
    // 深底保留
    expect(out).toContain('background-color')
    // 子树内 authored 配色不动 (哪怕是深字 — 成套保留)
    expect(out).toContain('color:#111111') // happy-dom 原样保留未触碰的 style 串
    // 子树外的深字正常翻转
    expect(out).toContain('rgb(')
  })

  it('does not leak the processing marker attribute', () => {
    const out = adaptHtmlForDarkMode('<div style="background-color:#222">x</div>')
    expect(out).not.toContain('data-ma-keep-bg')
  })

  it('leaves unparseable declarations untouched', () => {
    const html = '<p style="color:var(--brand)">x</p>'
    expect(adaptHtmlForDarkMode(html)).toContain('var(--brand)')
  })

  it('returns input unchanged for empty string', () => {
    expect(adaptHtmlForDarkMode('')).toBe('')
  })
})
