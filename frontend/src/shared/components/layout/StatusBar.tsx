// 24px bottom status bar — keeps the Sprint 10 6-segment layout (Sync ·
// Island · Mailbox · LLM · Theme/Accent · Version) but each segment now
// carries a `title=` tooltip so hovering surfaces multi-line detail
// without changing the cursor. No `cursor-help` (no question-mark mouse).

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Cpu, Database, Layers } from 'lucide-react'

import type { IslandConnectionState } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useAppearance } from '@shared/state/appearance'
import { useMailbox } from '@shared/state/mailbox'
import { useUpdaterStore, setUpdaterStatus } from '@shared/state/updater'
import { useMailApi } from '@shared/hooks/useMailApi'
import { islandStateI18nKey, setIslandStatus, useIslandStore } from '@shared/state/island'

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

function Sep(): React.ReactElement {
  return <span className="text-ink-fg-3 px-2">·</span>
}

interface SegmentProps {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}

function Segment({ icon, title, children }: SegmentProps): React.ReactElement {
  return (
    <HoverTip text={title} className="gap-1.5">
      {icon}
      {children}
    </HoverTip>
  )
}

export function StatusBar(): React.ReactElement {
  const { t } = useTranslation()
  const resolved = useAppearance((s) => s.resolvedTheme)
  const accent = useAppearance((s) => s.accent)
  const active = useMailbox((s) => s.active)
  const mailApi = useMailApi()
  const islandStatus = useIslandStore((s) => s.status)
  const status = useUpdaterStore((s) => s.status)

  // Sprint 8 §2.2 — version hydrate + live event subscribe.
  useEffect(() => {
    let cancelled = false
    void mailApi.updater
      .status()
      .then((s) => {
        if (!cancelled) setUpdaterStatus(s)
      })
      .catch(() => {
        /* preload missing in tests; keep initial seed. */
      })
    const unsubscribe = mailApi.updater.onEvent((next) => setUpdaterStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mailApi])

  // Sprint 11 V1.4 — Island hydration moved here from TitleBar.
  useEffect(() => {
    let cancelled = false
    void mailApi.island
      .status()
      .then((s) => {
        if (!cancelled) setIslandStatus(s)
      })
      .catch(() => {
        /* HttpApi V2 stub — keep initial idle state */
      })
    const unsubscribe = mailApi.island.onEvent((next) => setIslandStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mailApi])

  const islandStateLabel = t(`titleBar.island.${islandStateI18nKey(islandStatus.state)}`, {
    defaultValue: islandStatus.state
  })

  const themeTooltip = `${t('statusbar.theme')} ${t(`settings.theme.${resolved}`)} · ${accent}`
  const versionTooltip = `${t('statusbar.version', { version: status.currentVersion ?? 'dev' })}${
    status.state === 'downloaded' ? ` · ${t('statusbar.updateReady')}` : ''
  }`

  return (
    <footer
      className={cn(
        'h-statusbar shrink-0 glass border-t border-ink-border/60',
        'flex items-center px-3 select-none',
        'text-meta font-mono text-ink-fg-2'
      )}
    >
      <Segment
        icon={<span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />}
        title={`${t('statusbar.synced')} · ${t('statusbar.mailbox')} ${active}`}
      >
        <span>{t('statusbar.synced')}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1">5s</span>
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

      <HoverTip text={versionTooltip} className="ml-auto gap-1.5">
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
      </HoverTip>
    </footer>
  )
}
