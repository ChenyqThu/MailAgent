// Sprint 3 §2.2 — markdown → safe HTML body renderer.
//
// 原本是邮件翻译 (markdown 单调路径) 的渲染层; Sprint Immersive-Translate 后
// 邮件翻译改走沉浸式注入 (不再渲染独立译文 panel), 但本组件被 AIChat 的
// MessageList 复用 — 它本质上是一个 inline-markdown → DOMPurified HTML 渲染器,
// 跟翻译解耦。命名沿用 TranslatedBody 是因为重命名/搬位置会牵连一连串 import,
// 收益不大; 等下次清理 chat 渲染层时再统一。
//
// 渲染能力 (邮件 / AI 回复都用得上):
//   - inline: **bold** / *italic* / ~~strike~~ / `code` / [text](url)
//   - block: heading (#-######) / list (- / *) / numbered list / blockquote (>)
//   - 段落 split: 双换行 → <p>; 单换行 → <br>
//   - URL linkify (http(s):// only, mailto/data 不处理)
//
// 不支持: 真 list 嵌套 / table / image / HTML 包裹 — 邮件回复 + AI 回复
// 不需要这些, markdown 复杂度刻意压在低位以保 sanitize 路径简单。

import { useMemo } from 'react'
import DOMPurify from 'dompurify'

interface Props {
  text: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  // Markdown link: [text](http(s)://...)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  // Bare http(s) URL → linkify (skips ones already inside an <a>)
  out = out.replace(
    /(^|[\s(])((https?:\/\/[^\s<)]+))/g,
    (_m, before: string, url: string) =>
      `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  )
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold then italic — bold first so **text** doesn't trigger the italic.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  return out
}

function renderBlock(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
  if (heading) {
    const level = heading[1].length
    return `<h${level}>${renderInline(heading[2])}</h${level}>`
  }
  if (/^>\s/.test(trimmed)) {
    const inner = trimmed.replace(/^>\s?/gm, '')
    return `<blockquote>${renderInline(inner).replace(/\n/g, '<br>')}</blockquote>`
  }
  // List block: every non-empty line begins with `- ` / `* ` / `1. `
  const lines = trimmed.split(/\n/)
  const allUnordered = lines.every((l) => /^\s*[-*]\s+/.test(l))
  const allOrdered = lines.every((l) => /^\s*\d+\.\s+/.test(l))
  if (allUnordered) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
    return `<ul>${items.join('')}</ul>`
  }
  if (allOrdered) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`)
    return `<ol>${items.join('')}</ol>`
  }
  return `<p>${renderInline(trimmed).replace(/\n/g, '<br>')}</p>`
}

// http(s) only — drops javascript: / data: / mailto: at the sanitiser level
// even if the markdown layer let one through.
const HTTP_URI = /^https?:\/\//i

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'span'
]

/** Auto-balance trailing unclosed markdown markers (** / `).
 *
 *  Streaming chat: LLM 输出 chunk-by-chunk, 中间状态可能含未闭合的 **bold
 *  或 `code` marker. renderInline 用 regex 要求闭合 — 不匹配 → 留 raw
 *  `**xxx` 在屏幕上, 直到下一 chunk 收到结尾才突然变 bold. 视觉跳动.
 *
 *  补救: 渲染前 preprocess 把奇数个 `**` 末尾 append `**` 自动闭合,
 *  奇数个 `` ` `` 也补一个. 流式期间一直显示为 bold/code; stream done 后
 *  count 自然变偶数, no-op, 跟原文一致.
 *
 *  不处理 single `*` (italic): 容易跟 `**` 的截断态冲突 (中流到 `*`
 *  其实是 bold 的前半), 误闭合反而引入 phantom italic. Bold 是 chat
 *  最常用 marker, 修这个就消大部分视觉跳动.
 */
function autoBalanceTrailingMarkers(s: string): string {
  let result = s
  const boldCount = (result.match(/\*\*/g) || []).length
  if (boldCount % 2 === 1) result += '**'
  const codeCount = (result.match(/`/g) || []).length
  if (codeCount % 2 === 1) result += '`'
  return result
}

function markdownToSafeHtml(md: string): string {
  const balanced = autoBalanceTrailingMarkers(md)
  const blocks = balanced.split(/\n\s*\n/)
  const rendered = blocks.map(renderBlock).join('\n')
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: HTTP_URI
  })
}

export function TranslatedBody({ text }: Props): React.ReactElement {
  const html = useMemo(() => markdownToSafeHtml(text), [text])
  return <div className="mail-body break-words" dangerouslySetInnerHTML={{ __html: html }} />
}

// Test-only — exposed so tests can exercise auto-balance + sanitize without
// React SSR / DOM mounting.
export const __testing = {
  autoBalanceTrailingMarkers,
  markdownToSafeHtml
}
