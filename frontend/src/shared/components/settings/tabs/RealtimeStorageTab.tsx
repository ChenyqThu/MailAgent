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
import type { PersistentSettings } from '@shared/api/types'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { AdvancedDisclosure } from '../parts/AdvancedDisclosure'
import { PathPicker } from '../parts/PathPicker'

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
      dotClass: 'bg-coral/100 animate-pulse motion-reduce:animate-none',
      labelKey: 'settings.realtime.connecting'
    },
    reconnecting: {
      chipClass: 'bg-coral/15 text-coral',
      dotClass: 'bg-coral/100 animate-pulse motion-reduce:animate-none',
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
      <PageHeader
        eyebrow={t('settings.realtime.page.eyebrow', { defaultValue: 'REALTIME & STORAGE' })}
        title={t('settings.realtime.page.title', { defaultValue: '实时与存储' })}
        description={t('settings.realtime.page.intro', {
          defaultValue: 'SSE 事件总线、Redis 队列与附件 / SQLite 本地存储路径。'
        })}
      />
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

      <AdvancedSubsection />
    </>
  )
}

function AdvancedSubsection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [settings, setSettings] = React.useState<PersistentSettings | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void api.settings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch(() => {
        /* HttpApi V2 stub — ignore on web build */
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <Section title={t('settings.advanced.title', { defaultValue: '高级' })}>
      <AdvancedDisclosure
        label={t('settings.advanced.toggle', { defaultValue: '展开高级设置' })}
        helper={t('settings.advanced.helper', {
          defaultValue: '内部参数与只读路径; 改之前请确认你知道在做什么.'
        })}
      >
        <EnvField
          envKey="LOG_LEVEL"
          control="select"
          label={t('settings.advanced.logLevel.label', { defaultValue: '日志级别' })}
          helper={t('settings.advanced.logLevel.helper', { defaultValue: '应用与 CLI 日志' })}
          options={[
            { value: 'DEBUG', label: 'DEBUG' },
            { value: 'INFO', label: 'INFO' },
            { value: 'WARNING', label: 'WARNING' },
            { value: 'ERROR', label: 'ERROR' }
          ]}
        />
        <EnvField
          envKey="SYNC_MODE"
          control="select"
          label={t('settings.advanced.syncMode.label', { defaultValue: '同步模式' })}
          helper={t('settings.advanced.syncMode.helper', {
            defaultValue: 'hybrid 走 SQLite radar + AppleScript, applescript_only 退回旧路径'
          })}
          options={[
            { value: 'hybrid', label: 'hybrid' },
            { value: 'applescript_only', label: 'applescript_only' }
          ]}
        />
        <EnvField
          envKey="MAILAGENT_OUTBOX_ENABLED"
          control="toggle"
          label={t('settings.advanced.outbox.enabled.label', { defaultValue: 'Outbox 灰度' })}
          helper={t('settings.advanced.outbox.enabled.helper', {
            defaultValue: 'Sprint 15 反向同步路径切换'
          })}
        />
        <EnvField
          envKey="MAILAGENT_OUTBOX_POLL_INTERVAL_SEC"
          control="number"
          label={t('settings.advanced.outbox.poll.label', { defaultValue: 'FanoutWorker 轮询' })}
          helper={t('settings.advanced.outbox.poll.helper', { defaultValue: '秒' })}
          min={1}
          max={60}
        />
        <EnvField
          envKey="MAILAGENT_OUTBOX_MAX_ATTEMPTS"
          control="number"
          label={t('settings.advanced.outbox.attempts.label', { defaultValue: 'Outbox 重试上限' })}
          helper={t('settings.advanced.outbox.attempts.helper', {
            defaultValue: '失败后进死信前重试次数'
          })}
          min={1}
          max={20}
        />
        <EnvField
          envKey="MAILAGENT_OUTBOX_CONCURRENCY"
          control="number"
          label={t('settings.advanced.outbox.concurrency.label', {
            defaultValue: 'Outbox 并发'
          })}
          helper={t('settings.advanced.outbox.concurrency.helper', {
            defaultValue: 'fanout 同时最多多少'
          })}
          min={1}
          max={10}
        />
        <EnvField
          envKey="STATS_REPORT_INTERVAL"
          control="number"
          label={t('settings.advanced.stats.interval.label', { defaultValue: '看板上报间隔' })}
          helper={t('settings.advanced.stats.interval.helper', { defaultValue: '秒' })}
          min={10}
          max={3600}
        />
        <EnvField
          envKey="SSE_LOCAL_HOST"
          control="readonly"
          label={t('settings.advanced.sse.host.label', { defaultValue: 'SSE 本机 host' })}
          helper={t('settings.advanced.sse.host.helper', {
            defaultValue: '渲染层硬绑 127.0.0.1, 修改会导致前端连不上'
          })}
        />
        <EnvField
          envKey="SSE_LOCAL_PORT"
          control="readonly"
          label={t('settings.advanced.sse.port.label', { defaultValue: 'SSE 本机端口' })}
          helper={t('settings.advanced.sse.port.helper', {
            defaultValue: '渲染层硬绑 9200, 修改会导致前端连不上'
          })}
        />
        <PathPicker
          settingsKey="dbPath"
          label={t('settings.advanced.dbPath.label', { defaultValue: 'SQLite 路径' })}
          helper={t('settings.advanced.dbPath.helper', {
            defaultValue: '默认 ~/Documents/MailAgent/data/sync_store.db'
          })}
          pickerTitle={
            t('settings.advanced.dbPath.pickerTitle', { defaultValue: '选择 SQLite 目录' }) ??
            undefined
          }
          currentPath={settings?.dbPath ?? null}
          onPersisted={(next) => setSettings((cur) => (cur ? { ...cur, dbPath: next } : cur))}
        />
        <PathPicker
          settingsKey="attachmentDir"
          label={t('settings.advanced.attachmentDir.label', { defaultValue: '附件目录' })}
          helper={t('settings.advanced.attachmentDir.helper', {
            defaultValue: '默认 ~/Documents/MailAgent/data/attachments'
          })}
          pickerTitle={
            t('settings.advanced.attachmentDir.pickerTitle', { defaultValue: '选择附件目录' }) ??
            undefined
          }
          currentPath={settings?.attachmentDir ?? null}
          onPersisted={(next) =>
            setSettings((cur) => (cur ? { ...cur, attachmentDir: next } : cur))
          }
        />
      </AdvancedDisclosure>
    </Section>
  )
}
