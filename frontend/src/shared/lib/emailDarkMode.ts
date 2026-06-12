// 深色主题邮件正文色彩适配 — 保色相亮度翻转 (hue-preserving lightness flip)。
//
// 问题 (dogfood round 3): iframe BODY_CSS 用 ink token 着色, 但邮件自带的
// inline `style="color:#000"` / `<font color>` / `bgcolor` 覆盖一切 → 深色
// 背景配黑字不可读。
//
// 业界做法 (Gmail dark / Outlook dark / Apple Mail): 不做 RGB 直减 (255-x 会
// 翻转色相, 蓝变橙), 而是转 HSL 只翻 L 分量 — 深蓝变亮蓝、黑变浅灰, 色相
// 与饱和度保持。规则:
//   - 前景 (color): L < FG_DARK_MAX 的暗字 → L 线性映射到 [0.55, 0.95]
//     (黑 → 0.95 浅灰, 0.45 → 0.55)。亮字 (发件人 authored 的深底亮字) 不动。
//   - 背景 (background-color / bgcolor): L > BG_LIGHT_MIN 的亮底 → 直接移除,
//     露出 app 主题底 (映射成深底会连带 border/阴影违和; Outlook 同做法)。
//     L ≤ BG_LIGHT_MIN 的深/中底 → 保留, 并且**其整棵子树的前景跳过翻转**
//     (发件人 authored 的深底配色是成套的, 拆开翻转会破坏对比)。
//   - 解析不了的值 (var()/inherit/currentcolor/冷门 named) → 保守跳过不动。
//
// 只在 resolvedTheme === 'dark' 时由 EmailBodyFrame 调用; 输入是 DOMPurify
// 消毒后的 HTML (本函数不承担安全职责, 仅色彩改写)。<style> 块第一版跳过
// (邮件正文 inline style 是绝对大头; Gmail 等 MUA 本身会把 style 块内联)。

const FG_DARK_MAX = 0.45
const FG_MAP_HI = 0.95
const FG_MAP_LO = 0.55
const BG_LIGHT_MIN = 0.6

/** 处理期间标记"保留了自身背景"的元素 — 其子树前景跳过翻转, 输出前清除。 */
const KEEP_BG_ATTR = 'data-ma-keep-bg'

// ── 颜色解析 ─────────────────────────────────────────────────────────────
// 邮件 HTML 里常见的 named colors (老派 MUA + Outlook)。冷门名不收 — 解析
// 失败即跳过, 保守不动比错翻安全。windowtext 是 Outlook 特产 (= 系统文字色,
// 实务上恒黑)。
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  olive: [128, 128, 0],
  lime: [0, 255, 0],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  brown: [165, 42, 42],
  indigo: [75, 0, 130],
  darkblue: [0, 0, 139],
  darkgreen: [0, 100, 0],
  darkred: [139, 0, 0],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  midnightblue: [25, 25, 112],
  royalblue: [65, 105, 225],
  steelblue: [70, 130, 180],
  windowtext: [0, 0, 0]
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 CSS 颜色字符串 → RGB。支持 #rgb/#rrggbb(aa)、rgb()/rgba() (逗号或
 *  空格分隔)、常用 named。解析失败返回 null (调用方跳过该声明)。 */
export function parseCssColor(raw: string): Rgb | null {
  const s = raw.trim().toLowerCase()
  if (s.length === 0) return null

  const named = NAMED_COLORS[s]
  if (named) return { r: named[0], g: named[1], b: named[2] }

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    if (/^[0-9a-f]{3,4}$/.test(hex)) {
      return {
        r: parseInt(hex[0]! + hex[0]!, 16),
        g: parseInt(hex[1]! + hex[1]!, 16),
        b: parseInt(hex[2]! + hex[2]!, 16)
      }
    }
    if (/^[0-9a-f]{6}$/.test(hex) || /^[0-9a-f]{8}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      }
    }
    return null
  }

  // rgb(0,0,0) / rgba(0,0,0,.5) / rgb(0 0 0 / 50%) — 百分比分量 (rgb(0%,0%,0%))
  // 邮件里极罕见, 不支持 (解析失败跳过)。
  const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/][^)]*)?\)$/.exec(s)
  if (m) {
    const r = Number(m[1])
    const g = Number(m[2])
    const b = Number(m[3])
    if (r > 255 || g > 255 || b > 255) return null
    return { r, g, b }
  }
  return null
}

// ── HSL 变换 ────────────────────────────────────────────────────────────

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tn = t
    if (tn < 0) tn += 1
    if (tn > 1) tn -= 1
    if (tn < 1 / 6) return p + (q - p) * 6 * tn
    if (tn < 1 / 2) return q
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  }
}

/** 暗前景 → 亮前景: L ∈ [0, FG_DARK_MAX) 线性映射到 [FG_MAP_HI, FG_MAP_LO]
 *  (黑 0 → 0.95 浅灰; 0.45 → 0.55), H/S 保持。亮字返回 null (不动)。 */
export function flipDarkForeground(raw: string): string | null {
  const rgb = parseCssColor(raw)
  if (!rgb) return null
  const { h, s, l } = rgbToHsl(rgb)
  if (l >= FG_DARK_MAX) return null
  const flipped = FG_MAP_HI - (l * (FG_MAP_HI - FG_MAP_LO)) / FG_DARK_MAX
  const out = hslToRgb(h, s, flipped)
  return `rgb(${out.r}, ${out.g}, ${out.b})`
}

/** 背景是否"亮底该移除" (L > BG_LIGHT_MIN)。解析失败返回 null (跳过)。 */
function classifyBackground(raw: string): 'remove' | 'keep' | null {
  const rgb = parseCssColor(raw)
  if (!rgb) return null
  return rgbToHsl(rgb).l > BG_LIGHT_MIN ? 'remove' : 'keep'
}

// ── DOM 遍历 ────────────────────────────────────────────────────────────

function processElement(el: HTMLElement): void {
  // 1) 背景: style background-color / 纯色 background 简写 / bgcolor 属性。
  //    任一保留 → 打 KEEP_BG_ATTR (自身 + 子树前景跳过)。
  let kept = false

  const styleBg = el.style.backgroundColor
  if (styleBg) {
    const cls = classifyBackground(styleBg)
    if (cls === 'remove') el.style.backgroundColor = ''
    else if (cls === 'keep') kept = true
  }
  // background 简写为纯色值时 (老派邮件常见 `background: #ffffff`) CSSOM 已把
  // backgroundColor 分量提出来 — 上面处理过; 但移除时还要清简写本身, 否则
  // serialize 后简写仍带色。仅当简写整体就是一个可解析颜色时动它。
  const styleShorthand = el.style.background
  if (styleShorthand) {
    const cls = classifyBackground(styleShorthand)
    if (cls === 'remove') el.style.background = ''
    else if (cls === 'keep') kept = true
  }
  const bgcolorAttr = el.getAttribute('bgcolor')
  if (bgcolorAttr !== null) {
    const cls = classifyBackground(bgcolorAttr)
    if (cls === 'remove') el.removeAttribute('bgcolor')
    else if (cls === 'keep') kept = true
  }
  if (kept) el.setAttribute(KEEP_BG_ATTR, '1')

  // 2) 前景: 深底子树 (含自身) 的 authored 配色成套保留。
  if (el.closest(`[${KEEP_BG_ATTR}]`) !== null) return

  const styleColor = el.style.color
  if (styleColor) {
    const flipped = flipDarkForeground(styleColor)
    if (flipped) el.style.color = flipped
  }
  // <font color="..."> — HTML4 遗产, Outlook/企业邮件仍大量产出。
  if (el.tagName === 'FONT') {
    const colorAttr = el.getAttribute('color')
    if (colorAttr !== null) {
      const flipped = flipDarkForeground(colorAttr)
      if (flipped) el.setAttribute('color', flipped)
    }
  }
}

/**
 * 深色主题下改写邮件 HTML 的 inline 配色 (保色相亮度翻转)。
 * 输入输出都是 body fragment HTML 字符串; 解析失败/空输入原样返回。
 */
export function adaptHtmlForDarkMode(html: string): string {
  if (html.length === 0) return html
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  const body = doc.body
  if (!body) return html

  // document order 遍历 (父先于子) — 背景标记先于子树前景判断。
  processElement(body as HTMLElement)
  body.querySelectorAll('*').forEach((node) => {
    processElement(node as HTMLElement)
  })

  // 清除处理期标记, 输出干净 HTML。
  body.querySelectorAll(`[${KEEP_BG_ATTR}]`).forEach((node) => {
    node.removeAttribute(KEEP_BG_ATTR)
  })
  body.removeAttribute(KEEP_BG_ATTR)

  return body.innerHTML
}
