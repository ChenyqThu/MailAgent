// Sprint 20 — /agents 共享原子：ReportIcon / Pip / Badge / StatusBadge /
// CadencePill / Switch。跨 BlockRenderer / ReportsPage / settings 配置页 /
// EmailSourcePanel 复用。组件集中在本文件（react-refresh：组件文件只导出组件），
// 纯函数 helpers 在 ./lib。
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowRight,
  BarChart3,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cog,
  Database,
  ExternalLink,
  FileSearch,
  FileText,
  Flag,
  Folder,
  History,
  Inbox,
  Info,
  Loader2,
  Mail,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'

import type { ReportCadence, ReportStatus, ReportTone } from '@shared/api/types'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { STATUS_META, toneAlpha, toneColor } from './lib'

// 设计稿 icon name → lucide 组件。
const ICON_MAP: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  alert: AlertTriangle,
  alertcircle: AlertCircle,
  checkcircle: CheckCircle2,
  check: Check,
  info: Info,
  folder: Folder,
  database: Database,
  zap: Zap,
  external: ExternalLink,
  clock: Clock,
  play: Play,
  cog: Cog,
  loader: Loader2,
  refresh: RefreshCw,
  barchart: BarChart3,
  chevronright: ChevronRight,
  chevrondown: ChevronDown,
  chevronleft: ChevronLeft,
  chevronup: ChevronUp,
  x: X,
  plus: Plus,
  search: Search,
  mail: Mail,
  history: History,
  message: MessageSquare,
  sliders: SlidersHorizontal,
  filesearch: FileSearch,
  filetext: FileText,
  inbox: Inbox,
  send: Send,
  archive: Archive,
  flag: Flag,
  bell: Bell,
  arrowright: ArrowRight,
  star: Sparkles
}

export function ReportIcon({
  name,
  size = 16,
  className,
  style
}: {
  name: string
  size?: number
  className?: string
  style?: React.CSSProperties
}): React.ReactElement {
  const C = ICON_MAP[name] ?? Folder
  return <C size={size} strokeWidth={1.75} className={className} style={style} aria-hidden="true" />
}

export function Pip({
  tone = 'neutral',
  children
}: {
  tone?: ReportTone
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        lineHeight: 1,
        padding: '3px 7px',
        borderRadius: 5,
        color: tone === 'neutral' ? 'rgb(var(--ink-fg-1))' : toneColor(tone),
        background: tone === 'neutral' ? 'rgb(var(--ink-fg) / 0.05)' : toneAlpha(tone, 0.12),
        border: `1px solid ${tone === 'neutral' ? 'rgb(var(--ink-border))' : toneAlpha(tone, 0.25)}`,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </span>
  )
}

export function Badge({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10,
        letterSpacing: '0.02em',
        padding: '2px 6px',
        borderRadius: 4,
        color: 'rgb(var(--c-accent))',
        background: 'rgb(var(--c-accent) / 0.10)',
        border: '1px solid rgb(var(--c-accent) / 0.25)',
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </span>
  )
}

export function StatusBadge({
  status,
  size = 'sm'
}: {
  status: ReportStatus
  size?: 'sm' | 'md'
}): React.ReactElement {
  const { t } = useTranslation()
  const tone = (STATUS_META[status] || STATUS_META.ready).tone
  const c = toneColor(tone)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: size === 'sm' ? 11 : 12,
        lineHeight: 1,
        padding: size === 'sm' ? '3px 7px' : '4px 9px',
        borderRadius: 5,
        fontWeight: 500,
        color: c,
        background: toneAlpha(tone, 0.12),
        border: `1px solid ${toneAlpha(tone, 0.25)}`
      }}
    >
      {status === 'generating' ? (
        <span className="spin" style={{ display: 'flex' }}>
          <ReportIcon name="loader" size={11} />
        </span>
      ) : (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
      )}
      {t(`agents.status.${status}`)}
    </span>
  )
}

export function CadencePill({ cadence }: { cadence: ReportCadence }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span
      style={{
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10.5,
        letterSpacing: '0.03em',
        padding: '2px 6px',
        borderRadius: 4,
        color: 'rgb(var(--ink-fg-2))',
        background: 'rgb(var(--ink-fg) / 0.05)',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      {t(`agents.cadence.${cadence}`, { defaultValue: cadence })}
    </span>
  )
}

export function Switch({
  on,
  onChange,
  size = 'md',
  ariaLabel
}: {
  on: boolean
  onChange: (v: boolean) => void
  size?: 'sm' | 'md'
  ariaLabel?: string
}): React.ReactElement {
  const w = size === 'sm' ? 34 : 40
  const h = size === 'sm' ? 20 : 23
  const k = h - 6
  const reduce = useReducedMotion()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      style={{
        width: w,
        height: h,
        borderRadius: h,
        padding: 0,
        border: 0,
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        background: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-5))',
        transition: reduce ? 'none' : 'background 120ms cubic-bezier(0.4,0,0.2,1)'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: 3,
          width: k,
          height: k,
          borderRadius: '50%',
          background: 'rgb(var(--c-accent-fg))',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transform: on ? `translateX(${w - k - 6}px)` : 'translateX(0)',
          transition: reduce ? 'none' : 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
        }}
      />
    </button>
  )
}
