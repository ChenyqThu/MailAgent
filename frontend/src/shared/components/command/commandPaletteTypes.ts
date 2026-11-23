import type React from 'react'
import type { PaletteScope } from './paletteMatters'

function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}

// G-A7 ① — 远程 web build 上 runSearchAgent 必返 E_UNSUPPORTED（LLM key 在桌面）。
export const IS_WEB = resolveBuildTarget() === 'web'

export const MAX_EMAIL_HITS = 50
export const MAX_JUMP_MAILBOXES = 3
// 通讯录 WP4「人」组：面板展示 8 条；服务端 limit 取 16 留出客户端滤 hidden 的余量。
export const MAX_CONTACT_HITS = 8
export const CONTACT_FETCH_LIMIT = 16
export const DEBOUNCE_MS = 250

const CJK_RATIO_THRESHOLD = 0.4
const CJK_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/g

// Static syntax legend shown in the empty-result tile.
export const SEARCH_SYNTAX_HINTS: ReadonlyArray<{ token: string; labelKey: string }> = [
  { token: 'from:', labelKey: 'palette.email.syntaxFrom' },
  { token: 'after:', labelKey: 'palette.email.syntaxAfter' },
  { token: 'has:attachment', labelKey: 'palette.email.syntaxHas' },
  { token: 'is:unread', labelKey: 'palette.email.syntaxUnread' }
]

// G-B3 — facet chips: clickable DSL tokens that toggle in/out of the query.
export const FIXED_FACETS: ReadonlyArray<{ token: string; labelKey: string }> = [
  { token: 'is:unread', labelKey: 'palette.facet.unread' },
  { token: 'has:attachment', labelKey: 'palette.facet.hasAttachment' }
]

export type Group = 'jump' | 'matter' | 'contact' | 'library' | 'ai' | 'email' | 'actions'

export interface JumpRow {
  id: string
  icon: React.ReactNode
  label: React.ReactNode
  aside?: React.ReactNode
  isAiEntry?: boolean
  run(): void
}

export interface ActionRow {
  id: string
  icon: React.ReactNode
  label: string
  meta: string
  iconTone: 'ok' | 'info' | 'coral'
  disabled?: boolean
  soon?: boolean
  run(): Promise<void>
}

export interface FlatEntry {
  group: Group
  indexInGroup: number
  disabled?: boolean
  isAiEntry?: boolean
  run(): void | Promise<void>
}

export interface ScopeItem {
  id: PaletteScope
  count: number
}

export function detectLang(s: string): 'zh' | 'en' {
  if (!s) return 'en'
  const matches = s.match(CJK_RE)
  const ratio = matches ? matches.length / s.length : 0
  return ratio >= CJK_RATIO_THRESHOLD ? 'zh' : 'en'
}
