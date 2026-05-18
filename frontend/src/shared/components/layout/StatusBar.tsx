// 24px bottom status bar · mockup-inbox.html footer. mono text-meta, ≥5
// segments separated by `text-ink-fg-3 ·` dividers. Sprint 2 wires what
// it can (active mailbox, theme, accent, version); the rest are static
// placeholders that Sprint 6 (admin stats live data) replaces.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Cpu, Database, Layers } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useAppearance } from '@shared/state/appearance'
import { useMailbox } from '@shared/state/mailbox'
import { useUpdaterStore, setUpdaterStatus } from '@shared/state/updater'
import { useMailApi } from '@shared/hooks/useMailApi'

function Sep(): React.ReactElement {
  return <span className="text-ink-fg-3 px-2">·</span>
}

function Segment({
  icon,
  children
}: {
  icon?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
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
  const mailApi = useMailApi()
  // Sprint 8 §2.2 — pull the real `app.getVersion()` from main on mount +
  // subscribe to broadcast so the version updates live when an installed
  // .dmg launches. SettingsPage's UpdateSection does the same thing — both
  // share the zustand store, so the read here piggybacks on whichever
  // mounted first.
  const status = useUpdaterStore((s) => s.status)
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

  return (
    <footer
      className={cn(
        'h-statusbar shrink-0 bg-ink-1 border-t border-ink-border',
        'flex items-center px-3',
        'text-meta font-mono text-ink-fg-2'
      )}
    >
      <Segment icon={<span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />}>
        <span>{t('statusbar.synced')}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1">5s</span>
      </Segment>
      <Sep />

      <Segment icon={<Database size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">{t('statusbar.mailbox')}</span>
        <span className="text-ink-fg-1">{active}</span>
      </Segment>
      <Sep />

      <Segment icon={<Cpu size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">{t('statusbar.llm')}</span>
        <span className="text-ink-fg-1">{t('statusbar.llmIdle')}</span>
      </Segment>
      <Sep />

      <Segment icon={<Activity size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">{t('statusbar.theme')}</span>
        <span className="text-ink-fg-1 uppercase">{resolved}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1 capitalize">{accent}</span>
      </Segment>

      <span className="ml-auto flex items-center gap-1.5">
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
