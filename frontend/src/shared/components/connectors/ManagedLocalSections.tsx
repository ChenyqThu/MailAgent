// Wave 3 `managed_local` 连接器 UI 子面板（浏览器 3 模式选择器 / macOS TCC 权限诊断 / 像素脱敏告知）。
// 仅依赖 Design v3 语义色 token，零硬编码 hex；所有含中文文本均 >= 14px（`text-aux` / `text-body`），
// 仅纯 ASCII URL 使用 `text-meta font-mono`。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ManagedBrowserMode,
  SystemPermissionKind,
  SystemPermissionState,
  SystemPermissionsStatus
} from '@shared/api/types'

import {
  CHROME_REMOTE_DEBUGGING_URL,
  MANAGED_BROWSER_MODES,
  PILL_BASE,
  copyTextToClipboard,
  fetchSystemPermissions,
  isManagedBrowserMode,
  openSystemPermissionPane
} from './consoleShared'

/** 诚实像素隐私告知：明确说明 privacyMaskMiddleware 仅脱敏出站文本，不对截图或屏幕画面打码。 */
export function ManagedPixelPrivacyNotice({
  className
}: {
  className?: string
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-[var(--r-card)] border border-warn/30 bg-warn/[0.06] px-3 py-2.5',
        className
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-aux font-medium text-ink-fg">
          {t('settings.connectors.managed.pixelPrivacyTitle')}
        </div>
        <p className="mt-0.5 text-aux leading-relaxed text-ink-fg-2">
          {t('settings.connectors.managed.pixelPrivacyBody')}
        </p>
      </div>
    </div>
  )
}

/** `browser_use`（`@playwright/mcp`）三种浏览器连接模式选择器与 `chrome://inspect/#remote-debugging` 引导。 */
export function ManagedBrowserModeSection({
  connectorId,
  currentMode,
  supportedModes,
  isWeb
}: {
  connectorId: string
  currentMode: ManagedBrowserMode
  supportedModes: string[]
  isWeb: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [savingMode, setSavingMode] = React.useState<ManagedBrowserMode | null>(null)
  const [copiedCdp, setCopiedCdp] = React.useState(false)

  const modes: ManagedBrowserMode[] = React.useMemo(() => {
    const filtered = supportedModes.filter(isManagedBrowserMode)
    return filtered.length > 0 ? filtered : [...MANAGED_BROWSER_MODES]
  }, [supportedModes])

  async function handleSelectMode(nextMode: ManagedBrowserMode): Promise<void> {
    if (isWeb || savingMode !== null || nextMode === currentMode) return
    if (!api.connector.setRuntimeOptions) return
    setSavingMode(nextMode)
    try {
      await api.connector.setRuntimeOptions(connectorId, {
        mode: nextMode,
        browser_mode: nextMode
      })
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      await qc.invalidateQueries({ queryKey: qk.connectorInstallStatus(connectorId) })
      toastSuccess(
        t('settings.connectors.managed.modeUpdated', {
          mode: t(`settings.connectors.managed.modes.${nextMode}.title`)
        })
      )
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    } finally {
      setSavingMode(null)
    }
  }

  async function handleCopyCdpUrl(): Promise<void> {
    const ok = await copyTextToClipboard(CHROME_REMOTE_DEBUGGING_URL)
    if (ok) {
      setCopiedCdp(true)
      toastSuccess(t('settings.connectors.managed.copiedCdpUrl'))
      window.setTimeout(() => setCopiedCdp(false), 1800)
    }
  }

  return (
    <section
      aria-label={t('settings.connectors.managed.browserModeTitle')}
      className="mt-3 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2/50 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-aux font-medium text-ink-fg">
            {t('settings.connectors.managed.browserModeTitle')}
          </h3>
          <p className="mt-0.5 text-aux text-ink-fg-2">
            {t('settings.connectors.managed.browserModeHelper')}
          </p>
        </div>
        {isWeb ? (
          <span className="text-aux text-ink-fg-3">
            {t('settings.connectors.managed.webDisabledShort')}
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 grid gap-2" role="radiogroup" aria-label={t('settings.connectors.managed.browserModeTitle')}>
        {modes.map((mode) => {
          const active = currentMode === mode
          const busy = savingMode === mode
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isWeb || savingMode !== null}
              onClick={() => void handleSelectMode(mode)}
              className={cn(
                'flex w-full items-start gap-3 rounded-[var(--r-ctl)] border px-3 py-2.5 text-left transition-colors duration-fast',
                active
                  ? 'border-coral/60 bg-coral/[0.06] text-ink-fg'
                  : 'border-ink-border-soft bg-ink-1 hover:bg-ink-3 text-ink-fg-1',
                (isWeb || savingMode !== null) && !active && 'opacity-60'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-coral bg-coral/15 text-coral' : 'border-ink-border bg-transparent'
                )}
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : active ? (
                  <Check className="size-3" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-aux font-medium text-ink-fg">
                    {t(`settings.connectors.managed.modes.${mode}.title`)}
                  </span>
                  {mode === 'cdp_chrome' ? (
                    <span className={cn(PILL_BASE, 'text-aux border-ok/30 bg-ok/15 text-ok')}>
                      {t('settings.connectors.managed.recommendedBadge')}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-aux leading-relaxed text-ink-fg-2">
                  {t(`settings.connectors.managed.modes.${mode}.desc`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {currentMode === 'cdp_chrome' ? (
        <div className="mt-2.5 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1 px-3 py-2.5">
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.connectors.managed.cdpGuideTitle')}
          </div>
          <p className="mt-0.5 text-aux leading-relaxed text-ink-fg-2">
            {t('settings.connectors.managed.cdpGuideBody')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-2 py-1 font-mono text-meta text-ink-fg">
              {CHROME_REMOTE_DEBUGGING_URL}
            </code>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => void handleCopyCdpUrl()}
            >
              {copiedCdp ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copiedCdp
                ? t('settings.connectors.managed.copiedCdpUrl')
                : t('settings.connectors.managed.copyCdpUrl')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

const TCC_BADGE_CLASS: Record<SystemPermissionState, string> = {
  granted: 'border-ok/30 bg-ok/15 text-ok',
  denied: 'border-fail/30 bg-fail/15 text-fail',
  unknown: 'border-warn/30 bg-warn/15 text-warn',
  unsupported: 'bg-ink-4 text-ink-fg-3'
}

function normalizePermissionState(raw: string | undefined): SystemPermissionState {
  if (raw === 'granted' || raw === 'denied' || raw === 'unsupported') return raw
  return 'unknown'
}

/** `desktop_use` macOS TCC 权限实时诊断与一键直达 System Settings 面板。 */
export function ManagedSystemPermissionsSection({
  isWeb
}: {
  isWeb: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [openingKind, setOpeningKind] = React.useState<SystemPermissionKind | null>(null)

  const permsQuery = useQuery<SystemPermissionsStatus>({
    queryKey: qk.connectorSystemPermissions(),
    queryFn: () => fetchSystemPermissions(api.connector),
    enabled: !isWeb,
    staleTime: 10_000,
    retry: false
  })

  async function handleOpenPane(kind: SystemPermissionKind): Promise<void> {
    if (isWeb || openingKind !== null) return
    setOpeningKind(kind)
    try {
      await openSystemPermissionPane(api.connector, kind)
    } catch (err) {
      toastError(t('settings.connectors.title'), errorMessage(err))
    } finally {
      setOpeningKind(null)
    }
  }

  const rows: {
    kind: SystemPermissionKind
    titleKey: string
    descKey: string
    state: SystemPermissionState
  }[] = [
    {
      kind: 'accessibility',
      titleKey: 'settings.connectors.managed.tccAccessibility',
      descKey: 'settings.connectors.managed.tccAccessibilityDesc',
      state: normalizePermissionState(permsQuery.data?.accessibility)
    },
    {
      kind: 'screen_recording',
      titleKey: 'settings.connectors.managed.tccScreenRecording',
      descKey: 'settings.connectors.managed.tccScreenRecordingDesc',
      state: normalizePermissionState(permsQuery.data?.screen_recording)
    }
  ]

  return (
    <section
      aria-label={t('settings.connectors.managed.tccTitle')}
      className="mt-3 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2/50 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-aux font-medium text-ink-fg">
            {t('settings.connectors.managed.tccTitle')}
          </h3>
          <p className="mt-0.5 text-aux text-ink-fg-2">
            {t('settings.connectors.managed.tccSubtitle')}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={isWeb || permsQuery.isFetching}
          onClick={() => void permsQuery.refetch()}
        >
          {permsQuery.isFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {t('settings.connectors.managed.tccRefresh')}
        </Button>
      </div>

      {isWeb ? (
        <p className="mt-2 text-aux text-ink-fg-3">
          {t('settings.connectors.managed.tccWebDisabled')}
        </p>
      ) : permsQuery.isError ? (
        <div className="mt-2 flex items-center gap-2 text-aux text-fail">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage(permsQuery.error)}</span>
        </div>
      ) : (
        <div className="mt-2.5 divide-y divide-ink-border-soft rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1">
          {rows.map((row) => (
            <div
              key={row.kind}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-aux font-medium text-ink-fg">{t(row.titleKey)}</span>
                  <span className={cn(PILL_BASE, 'text-aux', TCC_BADGE_CLASS[row.state])}>
                    {permsQuery.isLoading && !permsQuery.data
                      ? t('settings.connectors.managed.tccChecking')
                      : t(`settings.connectors.managed.tccState.${row.state}`)}
                  </span>
                </div>
                <p className="mt-0.5 text-aux text-ink-fg-2">{t(row.descKey)}</p>
              </div>
              {row.state !== 'unsupported' ? (
                <Button
                  size="sm"
                  variant={row.state === 'granted' ? 'ghost' : 'secondary'}
                  type="button"
                  disabled={openingKind !== null}
                  onClick={() => void handleOpenPane(row.kind)}
                >
                  {openingKind === row.kind ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="size-3.5" />
                  )}
                  {t('settings.connectors.managed.tccOpenSettings')}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
