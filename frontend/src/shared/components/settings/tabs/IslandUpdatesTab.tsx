// Sprint 18 §PR D — Island & Updates tab.
//
// Island (ping-island unix socket bridge) + electron-updater 整合在一个 Tab.
// 两套各自有 status / control,内嵌实现避免抽 SettingsPage 老组件 — PR C
// 删 SettingsPage 时不需要先做 parts/ 提取.
//
// Island PING_ISLAND_ENABLED 在 .env 端控制 Python 的发送行为 (mail-sync
// 是否往 socket 推),island:setEnabled IPC 控制 main 进程的 probe / send
// 路径开关。两者要并行——所以 toggle 走 EnvField + 用户额外按 enable/disable
// 按钮再手动 sync 渲染层. 不做 enforcement (无 single SSoT) 因为这两个
// 进程边界天然独立; 注释里点明这个 caveat.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Download, RotateCcw } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useIslandStore, setIslandStatus, islandStateI18nKey } from '@shared/state/island'
import { useUpdaterStore } from '@shared/state/updater'
import { toastError, toastSuccess } from '@shared/state/toast'
import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'

/** Map the Island state to a chip color triple, matching SettingsPage's
 *  legacy palette so the visual carries over once PR C swaps them. */
function islandChipClass(
  state: ReturnType<typeof useIslandStore.getState>['status']['state']
): string {
  switch (state) {
    case 'connected':
      return 'bg-ok/15 text-ok'
    case 'degraded':
      return 'bg-warn/15 text-warn'
    case 'disconnected':
      return 'bg-fail/15 text-fail'
    default:
      return 'bg-ink-3 text-ink-fg-2'
  }
}

function islandDotClass(
  state: ReturnType<typeof useIslandStore.getState>['status']['state']
): string {
  switch (state) {
    case 'connected':
      return 'bg-ok'
    case 'degraded':
      return 'bg-warn'
    case 'disconnected':
      return 'bg-fail'
    default:
      return 'bg-ink-fg-3'
  }
}

function IslandSubsection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const status = useIslandStore((s) => s.status)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void api.island
      .status()
      .then((s) => {
        if (!cancelled) setIslandStatus(s)
      })
      .catch(() => {
        /* HttpApi V2 stub throws — ignore on web build */
      })
    const unsubscribe = api.island.onEvent((next) => setIslandStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api])

  const stateKey = islandStateI18nKey(status.state)
  const stateLabel = t(`settings.island.state.${stateKey}`, { defaultValue: status.state })

  async function handleTest(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const next = await api.island.testConnection()
      setIslandStatus(next)
      if (next.state === 'connected') {
        toastSuccess(t('settings.island.testOk'))
      } else {
        toastError(t('settings.island.testFail'), next.lastError ?? next.state)
      }
    } catch (err) {
      toastError(t('settings.island.testFail'), (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const showInstallHint = status.state === 'disconnected'

  return (
    <Section title={t('settings.island.heading')} helper={t('settings.island.channel')}>
      <Row label={t('settings.island.statusLabel')}>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-meta font-mono',
              islandChipClass(status.state)
            )}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', islandDotClass(status.state))} />
            {stateLabel}
          </span>
          <Button
            onClick={() => void handleTest()}
            disabled={busy || status.state === 'disabled'}
            variant="outline"
            size="sm"
          >
            {busy ? <Loader2 className="size-3" /> : <RefreshCw className="size-3" />}
            {busy ? t('settings.island.testing') : t('settings.island.testConnection')}
          </Button>
        </div>
      </Row>
      <EnvField
        envKey="PING_ISLAND_ENABLED"
        control="toggle"
        label={t('settings.island.enable')}
        helper={t('settings.island.enableHint')}
      />
      <Row label={t('settings.island.socketPath')}>
        <div
          className={cn(
            'rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
            'text-aux text-ink-fg font-mono truncate w-[260px]'
          )}
          title={status.socketPath}
        >
          {status.socketPath}
        </div>
      </Row>
      {showInstallHint ? (
        <div className="px-4 py-3 text-meta text-ink-fg-2 leading-relaxed">
          {t('settings.island.installHint')}{' '}
          <a
            href="https://github.com/ChenyqThu/ping-island/tree/feat/mail-brand"
            target="_blank"
            rel="noopener noreferrer"
            className="text-coral hover:underline"
          >
            {t('settings.island.installLinkLabel')}
          </a>
        </div>
      ) : null}
    </Section>
  )
}

function UpdaterSubsection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const status = useUpdaterStore((s) => s.status)
  const setStatus = useUpdaterStore((s) => s.setStatus)

  React.useEffect(() => {
    let cancelled = false
    void api.updater
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        /* V2 web stub — ignore */
      })
    const unsubscribe = api.updater.onEvent((next) => setStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api, setStatus])

  const [busy, setBusy] = React.useState<'check' | 'download' | 'install' | null>(null)

  // Auto-update §7 (gap A UI) — settings.json autoDownloadUpdates 的 toggle.
  // 走 PathPicker 同款 precedent: 挂载时 api.settings.get() 读初值, onChange
  // 经 api.settings.set() 写回 + 用返回值刷新本地 state。null = 尚未加载完
  // (toggle 暂禁用)。
  const [autoDownload, setAutoDownload] = React.useState<boolean | null>(null)
  const [autoDownloadBusy, setAutoDownloadBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void api.settings
      .get()
      .then((s) => {
        if (!cancelled) setAutoDownload(s.autoDownloadUpdates)
      })
      .catch(() => {
        /* web stub — leave null, toggle stays disabled */
      })
    return () => {
      cancelled = true
    }
  }, [api])

  async function handleAutoDownloadChange(next: boolean): Promise<void> {
    setAutoDownloadBusy(true)
    // Optimistic flip so the Switch tracks immediately; revert on failure.
    setAutoDownload(next)
    try {
      const updated = await api.settings.set({ autoDownloadUpdates: next })
      setAutoDownload(updated.autoDownloadUpdates)
    } catch (err) {
      setAutoDownload(!next)
      toastError(
        t('settings.update.autoDownload', { defaultValue: '自动下载更新' }),
        (err as Error).message
      )
    } finally {
      setAutoDownloadBusy(false)
    }
  }

  async function withBusy(kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> {
    setBusy(kind)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const handleCheck = (): Promise<void> =>
    withBusy('check', async () => {
      const next = await api.updater.check()
      setStatus(next)
    })

  const handleDownload = (): Promise<void> =>
    withBusy('download', async () => {
      const next = await api.updater.download()
      setStatus(next)
    })

  const handleInstall = (): Promise<void> =>
    withBusy('install', async () => {
      await api.updater.quitAndInstall()
    })

  const stateLabelKey = `settings.update.${status.state === 'not-available' ? 'upToDate' : status.state}`
  const stateLabel = t(stateLabelKey, { defaultValue: status.state })

  return (
    <Section title={t('settings.update.heading')}>
      <Row label={t('settings.update.currentVersion')}>
        <span className="text-aux font-mono text-ink-fg">v{status.currentVersion}</span>
      </Row>
      <Row label={t('settings.update.channel')} helper={status.message ?? undefined}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-meta font-mono text-ink-fg-2">{stateLabel}</span>
          {status.state === 'idle' ||
          status.state === 'not-available' ||
          status.state === 'error' ? (
            <Button
              onClick={() => void handleCheck()}
              disabled={busy !== null}
              variant="outline"
              size="sm"
            >
              {busy === 'check' ? <Loader2 className="size-3" /> : <RefreshCw className="size-3" />}
              {busy === 'check' ? t('settings.update.checking') : t('settings.update.checkNow')}
            </Button>
          ) : null}
          {status.state === 'available' ? (
            <Button
              onClick={() => void handleDownload()}
              disabled={busy !== null}
              variant="outline"
              size="sm"
            >
              {busy === 'download' ? (
                <Loader2 className="size-3" />
              ) : (
                <Download className="size-3" />
              )}
              {busy === 'download'
                ? t('settings.update.downloading')
                : t('settings.update.downloadCta')}
            </Button>
          ) : null}
          {status.state === 'downloaded' ? (
            <Button
              onClick={() => void handleInstall()}
              disabled={busy !== null}
              variant="default"
              size="sm"
            >
              <RotateCcw className="size-3" />
              {t('settings.update.restartCta')}
            </Button>
          ) : null}
        </div>
      </Row>
      {status.state === 'downloading' && status.downloadPercent !== null ? (
        <Row label={t('settings.update.downloading')}>
          <div className="w-[260px] h-2 rounded-full bg-ink-3 overflow-hidden">
            <div
              className="h-full bg-coral/100 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, status.downloadPercent))}%` }}
            />
          </div>
        </Row>
      ) : null}
      {/* Auto-update §7 — auto-download toggle (Q2: default ON, user can opt
          out). disabled until the first settings:get resolves (null) or while
          a write is in flight. */}
      <Row
        label={t('settings.update.autoDownload', { defaultValue: '自动下载更新' })}
        helper={t('settings.update.autoDownloadHint', {
          defaultValue: '检测到新版本后自动在后台下载,就绪后提示重启安装。'
        })}
      >
        <Switch
          checked={autoDownload ?? false}
          disabled={autoDownload === null || autoDownloadBusy}
          onCheckedChange={(checked) => void handleAutoDownloadChange(checked)}
          aria-label={t('settings.update.autoDownload', { defaultValue: '自动下载更新' })}
        />
      </Row>
      {/* Auto-update §7 — unsigned/dev builds can check but not install. Surface
          a subtle note so users aren't silently misled (acceptance criterion).
          status.enabled === false covers dev-disabled, flag-off, and unbound. */}
      {!status.enabled ? (
        <div className="px-4 py-3 text-meta text-ink-fg-2 leading-relaxed">
          {t('settings.update.unsignedNotice', {
            defaultValue: '开发/未签名版本仅支持检查更新;应用更新需正式签名版本。'
          })}
        </div>
      ) : null}
    </Section>
  )
}

export function IslandUpdatesTab(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader
        eyebrow={t('settings.island.page.eyebrow', { defaultValue: 'ISLAND & UPDATES' })}
        title={t('settings.island.page.title', { defaultValue: '灵动岛与更新' })}
        description={t('settings.island.page.intro', {
          defaultValue: 'ping-island 桥接状态与应用自动更新通道。'
        })}
      />
      <IslandSubsection />
      <UpdaterSubsection />
    </>
  )
}
