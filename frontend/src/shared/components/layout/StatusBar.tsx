// 24px bottom status bar — Sprint 10 6-segment layout (Sync · Island ·
// Mailbox · LLM · Theme/Accent · Version). Sprint 12.6 user-feedback —
// removed the floating HoverTip overlay: the segment label already shows
// every field the tooltip would have shown (mailbox name, theme/accent,
// version), so the popup was pure visual repetition. We keep `title=` so
// the OS-level tooltip still surfaces multi-line detail after a long
// hover, just without our own floating chip.

import { useTranslation } from 'react-i18next'
import { Activity, Cpu, Database, Layers } from 'lucide-react'

import type { EventsConnectionState, IslandConnectionState } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useAppearance } from '@shared/state/appearance'
import { useMailbox } from '@shared/state/mailbox'
import { useUpdaterStore } from '@shared/state/updater'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { islandStateI18nKey, useIslandStore } from '@shared/state/island'

function islandDotClass(state: IslandConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-ok'
    case 'degraded':
      return 'bg-warn'
    case 'idle':
    case 'disconnected':
    case 'dev-disabled':
    case 'disabled':
    default:
      return 'bg-ink-fg-3'
  }
}

// Sprint 16 — sync segment view-model based on SSE state + fallback polling.
// Returns dot color class, short label (live / connecting / 断线·兜底Ns / …)
// and a verbose tooltip string. All visible text comes from i18n.
interface SyncView {
  dot: string
  label: string
  tooltip: string
}

function buildSyncView(
  t: (k: string, opts?: Record<string, unknown>) => string,
  sseState: EventsConnectionState,
  fallbackMs: number | false
): SyncView {
  const fallbackSec =
    typeof fallbackMs === 'number' && fallbackMs > 0 ? Math.round(fallbackMs / 1000) : null
  switch (sseState) {
    case 'connected':
      return {
        dot: 'bg-ok',
        label: t('statusbar.sync.live'),
        tooltip: t('statusbar.sync.tooltipConnected')
      }
    case 'connecting':
      return {
        dot: 'bg-coral/100 animate-pulse motion-reduce:animate-none',
        label: t('statusbar.sync.connecting'),
        tooltip: t('statusbar.sync.tooltipConnected')
      }
    case 'reconnecting':
      return {
        dot: 'bg-coral/100 animate-pulse motion-reduce:animate-none',
        label: t('statusbar.sync.reconnecting'),
        tooltip:
          fallbackSec !== null
            ? t('statusbar.sync.tooltipFallback', { seconds: fallbackSec })
            : t('statusbar.sync.tooltipFallbackOff')
      }
    case 'disconnected':
      return {
        dot: 'bg-fail',
        label:
          fallbackSec !== null
            ? t('statusbar.sync.fallbackTpl', { seconds: fallbackSec })
            : t('statusbar.sync.fallbackOff'),
        tooltip:
          fallbackSec !== null
            ? t('statusbar.sync.tooltipFallback', { seconds: fallbackSec })
            : t('statusbar.sync.tooltipFallbackOff')
      }
    case 'disabled':
      return {
        dot: 'bg-ink-fg-3',
        label: t('statusbar.sync.disabled'),
        tooltip: t('statusbar.sync.tooltipDisabled')
      }
    case 'idle':
    default:
      return {
        dot: 'bg-ink-fg-3',
        label: t('statusbar.sync.idle'),
        tooltip: t('statusbar.sync.tooltipDisabled')
      }
  }
}

function Sep(): React.ReactElement {
  // mockup-inbox.html line 2604 / mockup-settings.html line 845 都用 pipe `|`
  // + `text-ink-fg-3` 单色, 间距由父容器 `gap-3` 控制 (segment 自身不加 px).
  return <span className="text-ink-fg-3">|</span>
}

interface SegmentProps {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}

function Segment({ icon, title, children }: SegmentProps): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {icon}
      {children}
    </span>
  )
}

export function StatusBar(): React.ReactElement {
  const { t } = useTranslation()
  const resolved = useAppearance((s) => s.resolvedTheme)
  const accent = useAppearance((s) => s.accent)
  const active = useMailbox((s) => s.active)
  const islandStatus = useIslandStore((s) => s.status)
  const status = useUpdaterStore((s) => s.status)
  // Sprint 16 — sync segment 真实状态: SSE 连接状态 + fallback polling 周期
  const sseState = useEventsStatusStore((s) => s.status.state)
  const fallbackMs = usePollingFallback()
  const sync = buildSyncView(t, sseState, fallbackMs)

  // Sprint 19 — updater / island 的 hydrate + 事件订阅已上移到 App 根 (单次订阅,
  // 见 App.tsx)。StatusBar 在每个路由都挂一份, 之前各自订阅导致 ipcRenderer 监听
  // 随路由切换累积 (MaxListenersExceededWarning)。这里只通过 store selector 读取
  // (islandStatus / status 见上)。
  const islandStateLabel = t(`titleBar.island.${islandStateI18nKey(islandStatus.state)}`, {
    defaultValue: islandStatus.state
  })

  const themeTooltip = `${t('statusbar.theme')} ${t(`settings.theme.${resolved}`)} · ${accent}`
  const versionTooltip = `${t('statusbar.version', { version: status.currentVersion ?? 'dev' })}${
    status.state === 'downloaded' ? ` · ${t('statusbar.updateReady')}` : ''
  }`

  return (
    // review round 10 — 正式方案: Tailwind `text-micro` (11px, 跟主 Sidebar
    // section header / SettingsRail eyebrow 同档) + `leading-[12px]` 覆盖
    // text-micro 默认 14px lh, 让 24px 高 statusbar 里两行更紧.
    // 不再加 inline fontSize 兜底 — 如果这次又被 cache 卡住, 重启 pnpm dev
    // 才是正解, 而不是绕开 Tailwind 系统.
    <footer
      className={cn(
        'h-statusbar shrink-0 glass border-t border-ink-border/60',
        'flex items-center px-3 gap-3 select-none',
        'font-mono text-ink-fg-2',
        'text-micro leading-[12px]'
      )}
    >
      <Segment
        icon={<span className={cn('w-1.5 h-1.5 rounded-full', sync.dot)} aria-hidden />}
        title={`${t('statusbar.sync.label')} · ${sync.tooltip}`}
      >
        <span className="text-ink-fg-3">{t('statusbar.sync.label')}</span>
        <span className="text-ink-fg-1">{sync.label}</span>
      </Segment>
      <Sep />

      <Segment
        icon={
          <span
            className={cn('w-1.5 h-1.5 rounded-full', islandDotClass(islandStatus.state))}
            aria-hidden
          />
        }
        title={`${t('titleBar.island.label')} · ${islandStateLabel}`}
      >
        <span className="text-ink-fg-3">{t('titleBar.island.label')}</span>
      </Segment>
      <Sep />

      <Segment
        icon={<Database size={11} strokeWidth={2} />}
        title={`${t('statusbar.mailbox')} · ${active}`}
      >
        <span className="text-ink-fg-3">{t('statusbar.mailbox')}</span>
        <span className="text-ink-fg-1">{active}</span>
      </Segment>
      <Sep />

      <Segment
        icon={<Cpu size={11} strokeWidth={2} />}
        title={`${t('statusbar.llm')} · ${t('statusbar.llmIdle')}`}
      >
        <span className="text-ink-fg-3">{t('statusbar.llm')}</span>
        <span className="text-ink-fg-1">{t('statusbar.llmIdle')}</span>
      </Segment>
      <Sep />

      <Segment icon={<Activity size={11} strokeWidth={2} />} title={themeTooltip}>
        <span className="text-ink-fg-3">{t('statusbar.theme')}</span>
        <span className="text-ink-fg-1">{t(`settings.theme.${resolved}`)}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1 capitalize">{accent}</span>
      </Segment>

      <span className="ml-auto inline-flex items-center gap-1.5" title={versionTooltip}>
        <Layers size={11} strokeWidth={2} className="text-ink-fg-3" />
        <span className="text-ink-fg-3">
          {t('statusbar.version', { version: status.currentVersion })}
        </span>
        {status.state === 'downloaded' && (
          <>
            <span className="text-ink-fg-3">·</span>
            <span className="text-coral">{t('statusbar.updateReady')}</span>
          </>
        )}
      </span>
    </footer>
  )
}
