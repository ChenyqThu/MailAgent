// roadmap §4.5 — top-bar red/orange dot badge.
//
// 5s polls admin:systemAlerts (direct sqlite read, ~1ms). Displays:
//   - red dot + count when any critical alerts
//   - orange dot + count when only warning alerts
//   - hidden when zero
//
// Tooltip lists the active alert titles. Clicking opens /admin.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ShieldAlert, AlertTriangle } from 'lucide-react'

import type { SystemAlertsData } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'

function buildTooltip(d: SystemAlertsData): string {
  if (d.alerts.length === 0) return 'no active alerts'
  return d.alerts.map((a) => `[${a.level}] ${a.title}`).join('\n')
}

export function SystemAlertBadge(): React.ReactElement | null {
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ['admin', 'systemAlerts'],
    queryFn: () => mailApi.admin.systemAlerts(),
    staleTime: 4_000,
    refetchInterval: 5_000
  })

  if (!q.data) return null
  const d = q.data
  if (d.critical_count === 0 && d.warning_count === 0) return null

  const isCritical = d.critical_count > 0
  const Icon = isCritical ? ShieldAlert : AlertTriangle
  const count = isCritical ? d.critical_count : d.warning_count
  // Show the higher-severity count; if both >0 show e.g. "2!+1"
  const display =
    d.critical_count > 0 && d.warning_count > 0
      ? `${d.critical_count}!+${d.warning_count}`
      : String(count)

  return (
    <button
      type="button"
      onClick={() => void navigate({ to: '/admin' })}
      title={buildTooltip(d)}
      aria-live="polite"
      aria-label={`${count} active system alert${count === 1 ? '' : 's'}`}
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
        <Icon size={11} strokeWidth={2.25} />
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
  )
}
