// Sprint 18 §PR D — Realtime & Storage tab.
//
// SSE 连接状态从 useEventsStatusStore (Sprint 16) 读, 主进程 events_bridge
// 持有 9200 SSE 长连接, 这里只展示 + 提供 reconnect CTA. Redis 事件源 + body
// 双写 + SSE server 开关都走 .env. 此 Tab 不含 Tier 2 Advanced (LOG_LEVEL /
// Outbox 4 项 / SSE host/port / dbPath / attachmentDir 等); PR F 在本 Tab
// 底部追加 AdvancedDisclosure 折叠.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'

import { useEventsStatusStore } from '@shared/state/eventsStatus'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { cn } from '@shared/lib/cn'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'

function StatusChip({
  status
}: {
  status: ReturnType<typeof useEventsStatusStore.getState>['status']
}): React.ReactElement {
  const { t } = useTranslation()
  const map: Record<
    typeof status.state,
    { chipClass: string; dotClass: string; labelKey: string }
  > = {
    connected: {
      chipClass: 'bg-ok/15 text-ok',
      dotClass: 'bg-ok',
      labelKey: 'settings.realtime.connected'
    },
    connecting: {
      chipClass: 'bg-coral/15 text-coral',
      dotClass: 'bg-coral/100 animate-pulse',
      labelKey: 'settings.realtime.connecting'
    },
    reconnecting: {
      chipClass: 'bg-coral/15 text-coral',
      dotClass: 'bg-coral/100 animate-pulse',
      labelKey: 'settings.realtime.reconnecting'
    },
    disconnected: {
      chipClass: 'bg-fail/15 text-fail',
      dotClass: 'bg-fail',
      labelKey: 'settings.realtime.disconnected'
    },
    disabled: {
      chipClass: 'bg-ink-3 text-ink-fg-2',
      dotClass: 'bg-ink-fg-3',
      labelKey: 'settings.realtime.disabled'
    },
    idle: {
      chipClass: 'bg-ink-3 text-ink-fg-2',
      dotClass: 'bg-ink-fg-3',
      labelKey: 'settings.realtime.idle'
    }
  }
  const entry = map[status.state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-meta font-mono',
        entry.chipClass
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', entry.dotClass)} />
      {t(entry.labelKey)}
    </span>
  )
}

export function RealtimeStorageTab(): React.ReactElement {
  const { t } = useTranslation()
  const status = useEventsStatusStore((s) => s.status)
  const api = useMailApi()
  const [reconnecting, setReconnecting] = React.useState(false)

  async function handleReconnect(): Promise<void> {
    setReconnecting(true)
    try {
      await api.events.reconnect()
      toastSuccess(t('settings.realtime.reconnectRequested'))
    } catch (err) {
      toastError(t('settings.realtime.reconnectFailed'), (err as Error).message)
    } finally {
      // Small grace period so the spinner is visible even when the IPC is
      // near-instant — the renderer shouldn't blink the button state.
      setTimeout(() => setReconnecting(false), 600)
    }
  }

  const showReconnect = status.state !== 'connected' && status.state !== 'disabled'

  return (
    <>
      <Section title={t('settings.realtime.sse.title')} helper={t('settings.realtime.sse.helper')}>
        <Row label={t('settings.realtime.label')} helper={t('settings.realtime.hint')}>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusChip status={status} />
            {showReconnect && (
              <button
                type="button"
                onClick={() => void handleReconnect()}
                disabled={reconnecting}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-aux',
                  'text-coral border border-coral/30 bg-coral/10 hover:bg-coral/15',
                  'transition-colors duration-fast',
                  'disabled:opacity-60 disabled:cursor-not-allowed'
                )}
              >
                {reconnecting ? <Loader2 className="size-3" /> : <RefreshCw className="size-3" />}
                {t('settings.realtime.reconnect')}
              </button>
            )}
            {status.lastError ? (
              <span
                className="text-meta font-mono text-ink-fg-3 break-all"
                title={status.lastError}
              >
                {status.lastError.length > 60
                  ? status.lastError.slice(0, 60) + '…'
                  : status.lastError}
              </span>
            ) : null}
          </div>
        </Row>
        <EnvField
          envKey="MAILAGENT_SSE_ENABLED"
          control="toggle"
          label={t('settings.realtime.sse.enabled.label')}
          helper={t('settings.realtime.sse.enabled.helper')}
        />
      </Section>

      <Section
        title={t('settings.realtime.redis.title')}
        helper={t('settings.realtime.redis.helper')}
      >
        <EnvField
          envKey="REDIS_EVENTS_ENABLED"
          control="toggle"
          label={t('settings.realtime.redis.enabled.label')}
          helper={t('settings.realtime.redis.enabled.helper')}
        />
        <EnvField
          envKey="REDIS_URL"
          control="text"
          label={t('settings.realtime.redis.url.label')}
          helper={t('settings.realtime.redis.url.helper')}
          placeholder="redis://localhost:6379"
        />
      </Section>

      <Section
        title={t('settings.realtime.body.title')}
        helper={t('settings.realtime.body.helper')}
      >
        <EnvField
          envKey="BODY_DUAL_WRITE_ENABLED"
          control="toggle"
          label={t('settings.realtime.body.dualWrite.label')}
          helper={t('settings.realtime.body.dualWrite.helper')}
        />
      </Section>

      {/* PR F: AdvancedDisclosure with Tier 2 fields (LOG_LEVEL / Outbox 4 项
          / SYNC_MODE / STATS_REPORT_INTERVAL / readonly SSE_LOCAL_{HOST,PORT}
          / dbPath / attachmentDir folder pickers) lands at the bottom of this
          section in a separate PR. */}
    </>
  )
}
