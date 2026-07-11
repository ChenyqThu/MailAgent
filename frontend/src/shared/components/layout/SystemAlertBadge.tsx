// roadmap §4.5 — top-bar red/orange dot badge.
//
// 5s polls admin:systemAlerts (direct sqlite read, ~1ms). Displays:
//   - red dot + count when any critical alerts
//   - orange dot + count when only warning alerts
//   - hidden when zero
//
// Clicking opens an alert-detail popover (same Portal + useExitAnimation
// pattern as the other TitleBar pickers) listing every active alert; its
// footer deep-links to the system board at /admin/kanban. Bare `/admin`
// is an Outlet-only parent — navigating there directly shows a blank page
// (the original Sprint-6-era behaviour of this badge).

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Info, ShieldAlert } from 'lucide-react'

import type { SystemAlertItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useMailApi } from '@shared/hooks/useMailApi'

const LEVEL_META: Record<SystemAlertItem['level'], { Icon: typeof ShieldAlert; cls: string }> = {
  critical: { Icon: ShieldAlert, cls: 'text-fail' },
  warning: { Icon: AlertTriangle, cls: 'text-warn' },
  info: { Icon: Info, cls: 'text-ink-fg-2' }
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function SystemAlertBadge(): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // popover 出入场：无 backdrop，从右上微展开（同 AccentPickerPopover）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })
  const q = useQuery({
    queryKey: qk.admin.systemAlerts(),
    queryFn: () => mailApi.admin.systemAlerts(),
    staleTime: 4_000,
    refetchInterval: 5_000
  })

  const total = (q.data?.critical_count ?? 0) + (q.data?.warning_count ?? 0)

  // 告警在弹窗打开期间清零 → badge 即将消失，弹窗一并收起。
  useEffect(() => {
    if (total === 0) setOpen(false)
  }, [total])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!q.data || total === 0) return null
  const d = q.data

  const isCritical = d.critical_count > 0
  const TriggerIcon = isCritical ? ShieldAlert : AlertTriangle
  const count = isCritical ? d.critical_count : d.warning_count
  // Show the higher-severity count; if both >0 show e.g. "2!+1"
  const display =
    d.critical_count > 0 && d.warning_count > 0
      ? `${d.critical_count}!+${d.warning_count}`
      : String(count)
  const asOf = formatTs(d.generated_at)

  const goBoard = (): void => {
    setOpen(false)
    void navigate({ to: '/admin/kanban' })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('titleBar.alerts.tooltip', { count: total })}
        aria-live="polite"
        aria-label={t('titleBar.alerts.aria', { count: total })}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-0.5 rounded-md text-meta font-mono',
          'border transition-colors duration-fast',
          isCritical
            ? 'bg-fail/15 text-fail border-fail/40 hover:bg-fail/25'
            : 'bg-warn/15 text-warn border-warn/40 hover:bg-warn/25'
        )}
      >
        <span className="relative inline-flex">
          <TriggerIcon size={11} strokeWidth={2.25} />
          {/* Pulse dot, only on critical */}
          {isCritical && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5">
              <span className="absolute inset-0 rounded-full bg-fail opacity-75 animate-ping" />
              <span className="absolute inset-0 rounded-full bg-fail" />
            </span>
          )}
        </span>
        <span className="tabular-nums">{display}</span>
      </button>

      {/* Portal to <body> so the popover escapes TitleBar's backdrop-filter
          stacking context (same reasoning as AccentPickerPopover). */}
      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('titleBar.alerts.title')}
            className="theme-popover glass-pop"
            style={{ width: 320, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="px-4 pt-3 pb-2 border-b border-ink-border-soft">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
                {t('titleBar.alerts.kicker')}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-aux text-ink-fg">{t('titleBar.alerts.title')}</span>
                {d.critical_count > 0 && (
                  <span className="px-1.5 rounded text-micro font-mono bg-fail/15 text-fail border border-fail/40">
                    {t('titleBar.alerts.critical', { count: d.critical_count })}
                  </span>
                )}
                {d.warning_count > 0 && (
                  <span className="px-1.5 rounded text-micro font-mono bg-warn/15 text-warn border border-warn/40">
                    {t('titleBar.alerts.warning', { count: d.warning_count })}
                  </span>
                )}
              </div>
            </div>

            <ul className="max-h-72 overflow-y-auto py-1">
              {d.alerts.map((a, i) => {
                const { Icon, cls } = LEVEL_META[a.level]
                const time = formatTs(a.ts)
                return (
                  <li
                    key={`${a.source}-${a.title}-${i}`}
                    className="px-4 py-2.5 flex items-start gap-2.5"
                  >
                    <Icon size={13} strokeWidth={2.25} className={cn('mt-0.5 shrink-0', cls)} />
                    <div className="min-w-0">
                      <div className="text-aux text-ink-fg leading-snug">{a.title}</div>
                      <div className="text-meta text-ink-fg-2 leading-snug mt-0.5">{a.message}</div>
                      <div className="text-micro font-mono text-ink-fg-3 mt-1">
                        {a.source}
                        {time ? ` · ${time}` : ''}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="px-4 py-2.5 border-t border-ink-border-soft flex items-center justify-between gap-2">
              <span className="text-micro font-mono text-ink-fg-3 truncate">
                {asOf ? t('titleBar.alerts.asOf', { time: asOf }) : ''}
              </span>
              <button
                type="button"
                onClick={goBoard}
                className={cn(
                  'flex items-center gap-1 shrink-0 text-meta text-ink-fg-2',
                  'hover:text-ink-fg transition-colors duration-fast'
                )}
              >
                {t('titleBar.alerts.goToBoard')}
                <ArrowRight size={11} strokeWidth={2} />
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
