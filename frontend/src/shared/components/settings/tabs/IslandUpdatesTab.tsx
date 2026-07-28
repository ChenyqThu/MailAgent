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
import { errorMessage } from '@shared/lib/ipcErrors'
import { useUpdaterStore } from '@shared/state/updater'
import { toastError, toastSuccess } from '@shared/state/toast'
import { cn } from '@shared/lib/cn'
import { RELEASE_DOWNLOAD_URL } from '@shared/lib/appReleases'
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
      toastError(t('settings.island.testFail'), errorMessage(err))
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
      {/* 邮件弹卡范围 (Lane 2 #1) — 直接决定被打扰频率。config.py 默认 'important',
          未设时 select 显示 placeholder「仅重要（默认）」如实反映生效值。 */}
      <EnvField
        envKey="ISLAND_MAIL_NOTIFY_SCOPE"
        control="select"
        label={t('settings.island.mailNotifyScope.label', { defaultValue: '邮件弹卡范围' })}
        helper={t('settings.island.mailNotifyScope.helper', {
          defaultValue:
            '决定哪些邮件会在灵动岛弹卡打扰你。「仅重要」（默认）只在 AI 判定为紧急或重要时弹；「全部」则每封新邮件都弹（比较吵）。不影响日历提醒、AI 审批等非邮件卡片。'
        })}
        options={[
          {
            value: 'important',
            label: t('settings.island.mailNotifyScope.important', {
              defaultValue: '仅重要（AI 判定紧急 / 重要才弹）'
            })
          },
          {
            value: 'all',
            label: t('settings.island.mailNotifyScope.all', {
              defaultValue: '全部（每封新邮件都弹）'
            })
          }
        ]}
        placeholder={t('settings.island.mailNotifyScope.placeholder', {
          defaultValue: '仅重要（默认）'
        })}
        placeholderOnEmpty
      />
      {/* 岛外观 (Lane 2 #10 追加) — App 本体有完整主题设置, 唯独岛的颜色/明暗此前
          只能改文件。六色值域 = .env.example:627 权威枚举 (DESIGN.md §2.7 同源);
          envelope metadata 透传 Swift, service.py 启动读 → 默认 restart 横幅。 */}
      <EnvField
        envKey="ISLAND_ACCENT"
        control="select"
        label={t('settings.island.accent.label', { defaultValue: '灵动岛主题色' })}
        helper={t('settings.island.accent.helper', {
          defaultValue: '灵动岛卡片的强调色，与 App 主界面的强调色相互独立。默认珊瑚色。'
        })}
        options={[
          {
            value: 'coral',
            label: t('settings.island.accent.coral', { defaultValue: '珊瑚 Coral（默认）' })
          },
          {
            value: 'cobalt',
            label: t('settings.island.accent.cobalt', { defaultValue: '钴蓝 Cobalt' })
          },
          {
            value: 'teal',
            label: t('settings.island.accent.teal', { defaultValue: '青 Teal' })
          },
          {
            value: 'rose',
            label: t('settings.island.accent.rose', { defaultValue: '玫瑰 Rose' })
          },
          {
            value: 'slate',
            label: t('settings.island.accent.slate', { defaultValue: '岩灰 Slate' })
          },
          {
            value: 'olive',
            label: t('settings.island.accent.olive', { defaultValue: '橄榄 Olive' })
          }
        ]}
        placeholder={t('settings.island.accent.placeholder', {
          defaultValue: '珊瑚 Coral（默认）'
        })}
        placeholderOnEmpty
      />
      <EnvField
        envKey="ISLAND_THEME"
        control="select"
        label={t('settings.island.islandTheme.label', { defaultValue: '灵动岛明暗' })}
        helper={t('settings.island.islandTheme.helper', {
          defaultValue: '灵动岛卡片用深色还是浅色底，与 App 主界面的明暗设置相互独立。默认深色。'
        })}
        options={[
          {
            value: 'dark',
            label: t('settings.island.islandTheme.dark', { defaultValue: '深色（默认）' })
          },
          {
            value: 'light',
            label: t('settings.island.islandTheme.light', { defaultValue: '浅色' })
          }
        ]}
        placeholder={t('settings.island.islandTheme.placeholder', {
          defaultValue: '深色（默认）'
        })}
        placeholderOnEmpty
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

/** 每日巡检 (Lane 2 #3) — MAILAGENT_DAILY_DIGEST_ENABLED 此前只有向导插件勾选一处 UI,
 *  触发钟点 (MAILAGENT_DAILY_DIGEST_HOURS) 则全无 UI：开了 digest 的用户必然想改时间,
 *  「开关有 UI、时间没有」= 半个功能。两者都是 config 启动读 → 默认 restart 横幅。
 *  service.py 里 digest 只在灵动岛开启时才跑, helper 如实说明这个前置。 */
function DigestSubsection(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Section
      title={t('settings.island.digest.heading', { defaultValue: '每日巡检' })}
      helper={t('settings.island.digest.sectionHelper', {
        defaultValue: '定时汇总最近邮件并在灵动岛推送一张巡检卡片；需先启用灵动岛。'
      })}
    >
      <EnvField
        envKey="MAILAGENT_DAILY_DIGEST_ENABLED"
        control="toggle"
        label={t('settings.island.digest.enable', { defaultValue: '启用每日巡检' })}
        helper={t('settings.island.digest.enableHint', {
          defaultValue:
            '在设定的钟点自动汇总这段时间的邮件（AI 生成摘要与待办建议），以卡片形式推送到灵动岛。默认关闭。'
        })}
      />
      <EnvField
        envKey="MAILAGENT_DAILY_DIGEST_HOURS"
        control="text"
        label={t('settings.island.digest.hours.label', { defaultValue: '巡检钟点' })}
        helper={t('settings.island.digest.hours.helper', {
          defaultValue:
            '每天几点巡检，24 小时制、逗号分隔（本机时区）。例如 9,18 表示早 9 点和晚 6 点各一次。'
        })}
        placeholder="9,18"
      />
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
        errorMessage(err)
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

  // feat/auto-update re-review (codex, LOW) — map the states whose i18n key
  // differs from the state string: not-available→upToDate, downloaded→readyToInstall,
  // dev-disabled→devDisabled (i18n key is camelCase but the state string is
  // hyphenated; without this the --dir/unpackaged graceful state renders the raw
  // "dev-disabled" enum). 'downloaded' has no settings.update.downloaded key either.
  const stateLabelKey = `settings.update.${
    status.state === 'not-available'
      ? 'upToDate'
      : status.state === 'downloaded'
        ? 'readyToInstall'
        : status.state === 'dev-disabled'
          ? 'devDisabled'
          : status.state
  }`
  // 这些状态串含 ICU 占位符: error={message} / available+readyToInstall={version}
  // / downloading={percent}。必须把对应值传进 t(), 否则 ICU 原样渲染 "{message}" 字面量
  // (此前 bug: 检查失败时显示 "更新检查失败:{message}" 而非真实错误)。多传无害。
  const stateLabel = t(stateLabelKey, {
    defaultValue: status.state,
    message: status.message ?? '',
    version: status.latestVersion ?? '',
    percent: status.downloadPercent ?? 0
  })

  return (
    <Section title={t('settings.update.heading')}>
      <Row label={t('settings.update.currentVersion')}>
        <span className="text-aux font-mono text-ink-fg">v{status.currentVersion}</span>
      </Row>
      <Row label={t('settings.update.channel')}>
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
          {/* available + 未签名 (ad-hoc, enabled=false): 应用内装不上 → 跳转下载页手动
              覆盖安装。<a target=_blank> 由 main 拦截 → 系统浏览器。 */}
          {status.state === 'available' && !status.enabled ? (
            <Button asChild variant="outline" size="sm">
              <a href={RELEASE_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                <Download className="size-3" />
                {t('settings.update.openDownloadCta', { defaultValue: '前往下载页' })}
              </a>
            </Button>
          ) : null}
          {/* available + 已签名 (未来 Developer ID 世界): 应用内下载 → 重启安装。 */}
          {status.state === 'available' && status.enabled ? (
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
                ? t('settings.update.downloading', { percent: status.downloadPercent ?? 0 })
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
        <Row label={t('settings.update.downloading', { percent: status.downloadPercent })}>
          <div className="w-[260px] h-2 rounded-full bg-ink-3 overflow-hidden">
            <div
              className="h-full bg-coral/100 transition-[width] duration-base ease-standard"
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
          // feat/auto-update re-review (renderer lens, LOW) — also disabled when
          // !status.enabled: the setting only takes effect once auto-update is
          // enabled (flag on + signed build), so on the default/unsigned build it
          // reads as inert, consistent with the unsignedNotice rendered below.
          disabled={autoDownload === null || autoDownloadBusy || !status.enabled}
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
            defaultValue:
              '当前为 ad-hoc 签名版本:支持检查更新;有新版本时请前往下载页手动下载、覆盖安装(应用内一键更新需正式签名版本)。'
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
      <DigestSubsection />
      <UpdaterSubsection />
    </>
  )
}
