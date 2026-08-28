// Sprint 20 — /agents 报告页共享工具：lucide 图标映射 + tone 色 + markdown-lite
// + section.summary 跳转解析 + 锚点滚动 + 时间格式 + 固定渲染 ctx。
//
// 设计稿（~/Downloads/agents/helpers.jsx）的 helpers 在此移植为 TSX：手写 SVG
// Icon → lucide-react；CSS 变量引用（rgb(var(--ink-2)) / rgb(var(--c-accent)/.1)）
// 与现网 index.css token 一致，自动随 theme/accent 切换。
import type { ReactNode } from 'react'

import type { ReportStatus, ReportTone } from '@shared/api/types'

// ReportIcon 见 ./primitives（组件集中在那，本文件只放纯函数 helpers）。

// ─── tone → CSS var ────────────────────────────────────────────────────────
const TONE_VAR: Record<string, string> = {
  neutral: '--c-norm',
  info: '--c-info',
  success: '--c-ok',
  warn: '--c-warn',
  critical: '--c-crit',
  impt: '--c-impt'
}
export function toneColor(tone: string | undefined): string {
  return `rgb(var(${TONE_VAR[tone ?? 'neutral'] ?? '--c-norm'}))`
}
/** rgb(var(--x) / alpha) — 因为 toneColor 已是 `rgb(var(--x))`，这里替换尾括号。 */
export function toneAlpha(tone: string | undefined, alpha: number): string {
  return toneColor(tone).replace(')', ` / ${alpha})`)
}

export function priorityTone(priority: string | undefined): ReportTone {
  if (!priority) return 'neutral'
  if (priority.includes('紧急') || priority.includes('🔴')) return 'critical'
  if (priority.includes('重要') || priority.includes('🟠') || priority.includes('🟡')) return 'warn'
  return 'neutral'
}

// ─── markdown-lite: **bold** / _italic_ / `code` ───────────────────────────
export function mdLite(text: string | undefined): ReactNode {
  if (!text) return null
  const parts: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(
        <strong key={key++} style={{ color: 'rgb(var(--ink-fg))', fontWeight: 600 }}>
          {tok.slice(2, -2)}
        </strong>
      )
    } else if (tok.startsWith('_')) {
      parts.push(
        <em key={key++} style={{ color: 'rgb(var(--ink-fg-2))' }}>
          {tok.slice(1, -1)}
        </em>
      )
    } else {
      parts.push(
        <code
          key={key++}
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.92em',
            background: 'rgb(var(--c-urg) / 0.12)',
            color: 'rgb(var(--c-urg))',
            padding: '1px 5px',
            borderRadius: 4
          }}
        >
          {tok.slice(1, -1)}
        </code>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// ─── section.summary: [文本](#email-<id>) 跳转链接 + **bold** ──────────────
export function renderSummary(text: string | undefined, onJump: (id: number) => void): ReactNode {
  if (!text) return null
  const parts: ReactNode[] = []
  const re = /\[([^\]]+)\]\(#email-(\d+)\)|\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[2]) {
      const id = parseInt(m[2], 10)
      parts.push(
        <a
          key={key++}
          href={`#email-${id}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onJump(id)
          }}
          style={{
            color: 'rgb(var(--c-accent))',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
            textDecorationColor: 'rgb(var(--c-accent) / 0.45)',
            textDecorationThickness: 1,
            cursor: 'pointer',
            fontWeight: 500
          }}
        >
          {m[1]}
        </a>
      )
    } else {
      parts.push(
        <strong key={key++} style={{ color: 'rgb(var(--ink-fg))', fontWeight: 600 }}>
          {m[3]}
        </strong>
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// task 06-08-chat Bug 2 — top whitespace reserved above the jump target. The
// report detail view (ReportsPage ReportDetailView) has a `position:sticky;
// top:0` meta header (~40px: padding 10px + caption). The old 18px landed the
// target row under that header, hiding its upper half ("跳转过头"). 64 ≈ sticky
// header ~40px + ~24px breathing room so the row sits fully below the header.
const SCROLL_TOP_MARGIN = 64

// ─── 滚动到报告内某封 email_item 锚点并高亮闪烁一次 ─────────────────────────
export function scrollToEmail(id: number): void {
  const el = document.getElementById(`email-${id}`)
  if (!el) return
  let c = el.parentElement
  while (c && c !== document.body) {
    const ov = getComputedStyle(c).overflowY
    if ((ov === 'auto' || ov === 'scroll') && c.scrollHeight > c.clientHeight + 4) break
    c = c.parentElement
  }
  if (c && c !== document.body) {
    const er = el.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    c.scrollBy({ top: er.top - cr.top - SCROLL_TOP_MARGIN, behavior: 'smooth' })
  }
  el.classList.remove('email-flash')
  void el.offsetWidth
  el.classList.add('email-flash')
  setTimeout(() => el.classList.remove('email-flash'), 1600)
}

// ─── 时间 / 标签 ────────────────────────────────────────────────────────────
export function fmtClock(value: string | number | undefined): string {
  if (value === undefined || value === '') return ''
  try {
    return new Date(value).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return String(value)
  }
}

export const STATUS_META: Record<ReportStatus, { tone: ReportTone }> = {
  ready: { tone: 'success' },
  generating: { tone: 'info' },
  failed: { tone: 'critical' },
  empty: { tone: 'neutral' },
  skipped: { tone: 'neutral' }
}

// ─── 固定渲染选择（用户定稿 tweak：console / list / hover / compact）────────
// 设计稿的 TweaksPanel 是预览用；生产烘焙这套定值，不出可切换面板。
export interface RenderCtx {
  layout: 'console' | 'document'
  rowStyle: 'list' | 'card'
  dense: boolean
  aiSummary: 'hover' | 'inline'
  onOpenEmail: (block: ReportEmailItemForPanel) => void
  onJump: (id: number) => void
}

/** EmailSourcePanel 需要的 email_item 字段子集。 */
export interface ReportEmailItemForPanel {
  internal_id: number
  subject?: string
  sender_name?: string
  sender_addr?: string
  time?: string
  category?: string
  priority?: string
  ai_summary?: string
  ai_action?: string
  source?: { notion_url: string | null; app_deeplink: string }
}

export const FIXED_RENDER = {
  layout: 'console' as const,
  rowStyle: 'list' as const,
  dense: true,
  aiSummary: 'hover' as const
}
