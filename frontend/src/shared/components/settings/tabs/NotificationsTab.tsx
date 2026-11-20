// Sprint 18 §PR D + Selectable Notification Channels & Action Items
// macOS 系统权限与常驻 + 分场景通知渠道与防重复 + 邮件/会议快捷动作 + 会前准备预设 + 飞书与事项通知。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useMatterFlags, useNotifyLevel, useSetNotifyLevel } from '@shared/components/matters/hooks'
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences
} from '@shared/components/notifications/hooks'
import type { MatterNotifyLevel } from '@shared/api/types/matter'
import type {
  MacNotificationAuthState,
  NotificationChannelPrefs,
  NotificationSystemStatus,
  PersistentSettings
} from '@shared/api/types'
import type {
  MailNotificationScope,
  MeetingPrepPresetMode,
  NotificationPreferences,
  ScenarioDeliveryMode
} from '@shared/api/types/notifications'
import { toastError, toastSuccess } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'

const DEFAULT_CHANNEL_PREFS: NotificationChannelPrefs = {
  action_required: 'banner',
  reviews: 'center_only',
  results: 'center_only',
  system: 'center_only'
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  mailDelivery: 'both',
  mailScope: 'urgent_and_important',
  mailActionsEnabled: true,
  meetingDelivery: 'both',
  meetingLeadMinutes: 10,
  meetingActionsEnabled: true,
  meetingPrepEnabled: false,
  meetingPrepMode: 'on_demand',
  meetingPrepLeadMinutes: 30,
  agentResultsDelivery: 'center_only',
  systemAlertsDelivery: 'center_only',
  suppressBannerWhenFocused: true,
  skipBannerWhenFeishuSent: true
}

const DELIVERY_MODES: readonly ScenarioDeliveryMode[] = [
  'both',
  'system_only',
  'center_only',
  'off'
]

function authStatusDotClass(supported: boolean, authState: MacNotificationAuthState): string {
  if (!supported) return 'bg-ink-fg-3'
  if (authState === 'delivered') return 'bg-ok'
  if (authState === 'prompted') return 'bg-warn'
  return 'bg-info'
}

function DeliverySelect({
  ariaLabel,
  value,
  disabled,
  onChange
}: {
  ariaLabel: string
  value: ScenarioDeliveryMode
  disabled: boolean
  onChange: (next: ScenarioDeliveryMode) => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event): void => onChange(event.target.value as ScenarioDeliveryMode)}
      className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg"
    >
      {DELIVERY_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {t(`settings.notifications.channels.deliveryOptions.${mode}`)}
        </option>
      ))}
    </select>
  )
}

export function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const { mattersEnabled } = useMatterFlags()
  const notifyLevel = useNotifyLevel(mattersEnabled)
  const setNotifyLevel = useSetNotifyLevel()

  const [settings, setSettings] = React.useState<PersistentSettings | null>(null)
  const [sysStatus, setSysStatus] = React.useState<NotificationSystemStatus | null>(null)
  const [savingDesktop, setSavingDesktop] = React.useState(false)
  const [testingNotify, setTestingNotify] = React.useState(false)

  const prefsQuery = useNotificationPreferences()
  const updatePrefsMut = useUpdateNotificationPreferences()
  const prefs = prefsQuery.data ?? DEFAULT_PREFERENCES
  const savingPrefs = updatePrefsMut.isPending

  const refreshSystemStatus = React.useCallback((): void => {
    void api.settings
      .systemNotificationStatus()
      .then((res): void => setSysStatus(res))
      .catch((): void => {})
  }, [api])

  React.useEffect((): (() => void) => {
    let cancelled = false
    void api.settings
      .get()
      .then((res): void => {
        if (!cancelled) setSettings(res)
      })
      .catch((): void => {})
    void api.settings
      .systemNotificationStatus()
      .then((res): void => {
        if (!cancelled) setSysStatus(res)
      })
      .catch((): void => {})
    return (): void => {
      cancelled = true
    }
  }, [api])

  const patchDesktop = React.useCallback(
    async (partial: Partial<PersistentSettings>): Promise<void> => {
      const prev = settings
      if (prev) {
        setSettings({
          ...prev,
          ...partial,
          notificationChannelPrefs: {
            ...DEFAULT_CHANNEL_PREFS,
            ...(prev.notificationChannelPrefs ?? {}),
            ...(partial.notificationChannelPrefs ?? {})
          }
        })
      }
      setSavingDesktop(true)
      try {
        const next = await api.settings.set(partial)
        setSettings(next)
      } catch (err) {
        if (prev) setSettings(prev)
        toastError(t('settings.notifications.desktop.saveFailed'), errorMessage(err))
      } finally {
        setSavingDesktop(false)
      }
    },
    [api, settings, t]
  )

  const handleRequestPermission = React.useCallback(
    async (silentIfAlreadyDelivered = false): Promise<void> => {
      setTestingNotify(true)
      try {
        const res = await api.settings.requestNotificationPermission()
        refreshSystemStatus()
        if (res.ok) {
          if (res.shown) {
            toastSuccess(t('settings.notifications.desktop.testOk'))
          } else if (!silentIfAlreadyDelivered) {
            toastSuccess(t('settings.notifications.desktop.testPrompted'))
          }
        } else {
          toastError(t('settings.notifications.desktop.testFailed'), res.detail ?? '')
        }
      } catch (err) {
        toastError(t('settings.notifications.desktop.testFailed'), errorMessage(err))
      } finally {
        setTestingNotify(false)
      }
    },
    [api, refreshSystemStatus, t]
  )

  const handleOpenSystemSettings = async (): Promise<void> => {
    try {
      const res = await api.settings.openNotificationSystemSettings()
      if (!res.ok) {
        toastError(t('settings.notifications.desktop.openSettingsFailed'))
      }
    } catch (err) {
      toastError(t('settings.notifications.desktop.openSettingsFailed'), errorMessage(err))
    }
  }

  const patchScenarioPrefs = React.useCallback(
    (patch: Partial<NotificationPreferences>): void => {
      const merged: NotificationPreferences = { ...prefs, ...patch }
      updatePrefsMut.mutate(patch, {
        onError: (err) => {
          toastError(t('settings.notifications.channels.saveFailed'), errorMessage(err))
        }
      })

      // 同步 Electron main 离线兜底配置（前台抑制 & 分类通道）
      const desktopPatch: Partial<PersistentSettings> = {}
      let hasDesktopPatch = false
      if ('suppressBannerWhenFocused' in patch) {
        desktopPatch.suppressBannerWhenFocused = patch.suppressBannerWhenFocused
        hasDesktopPatch = true
      }
      if (
        'mailDelivery' in patch ||
        'meetingDelivery' in patch ||
        'agentResultsDelivery' in patch ||
        'systemAlertsDelivery' in patch
      ) {
        const currentDesktop = {
          ...DEFAULT_CHANNEL_PREFS,
          ...(settings?.notificationChannelPrefs ?? {})
        }
        const actionWantsBanner =
          merged.mailDelivery === 'both' ||
          merged.mailDelivery === 'system_only' ||
          merged.meetingDelivery === 'both' ||
          merged.meetingDelivery === 'system_only'
        const actionAllOff = merged.mailDelivery === 'off' && merged.meetingDelivery === 'off'
        currentDesktop.action_required = actionAllOff
          ? 'off'
          : actionWantsBanner
            ? 'both'
            : 'center_only'
        currentDesktop.reviews = merged.mailDelivery
        currentDesktop.results = merged.agentResultsDelivery
        currentDesktop.system = merged.systemAlertsDelivery
        desktopPatch.notificationChannelPrefs = currentDesktop
        hasDesktopPatch = true
      }
      if (hasDesktopPatch) {
        void patchDesktop(desktopPatch)
      }

      const enabledSystemBanner = (
        [
          patch.mailDelivery,
          patch.meetingDelivery,
          patch.agentResultsDelivery,
          patch.systemAlertsDelivery
        ] as Array<ScenarioDeliveryMode | undefined>
      ).some((mode) => mode === 'both' || mode === 'system_only')

      if (
        enabledSystemBanner &&
        sysStatus?.supported &&
        (sysStatus.authState ?? 'unknown') === 'unknown'
      ) {
        void handleRequestPermission(true)
      }
    },
    [prefs, updatePrefsMut, settings, patchDesktop, sysStatus, handleRequestPermission, t]
  )

  const authState: MacNotificationAuthState = !sysStatus?.supported
    ? 'unsupported'
    : (sysStatus.authState ?? 'unknown')

  const authStatusText =
    authState === 'unsupported'
      ? t('settings.notifications.desktop.unsupported')
      : authState === 'delivered'
        ? t('settings.notifications.desktop.authDelivered')
        : authState === 'prompted'
          ? t('settings.notifications.desktop.authPrompted')
          : t('settings.notifications.desktop.authUnknown')

  const isDarwin = (sysStatus?.platform ?? 'darwin') === 'darwin'
  const mailBannerActive = prefs.mailDelivery === 'both' || prefs.mailDelivery === 'system_only'

  return (
    <>
      <PageHeader
        eyebrow={t('settings.notifications.page.eyebrow', { defaultValue: 'NOTIFICATIONS' })}
        title={t('settings.notifications.page.title', { defaultValue: '通知' })}
        description={t('settings.notifications.page.intro', {
          defaultValue: '系统通知权限、分场景提醒渠道、会前准备预设与飞书推送。'
        })}
      />

      {/* 1. macOS 系统通知权限与常驻 */}
      <Section
        title={t('settings.notifications.desktop.title')}
        helper={t('settings.notifications.desktop.helper')}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 py-1">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-body font-medium text-ink-fg">
              {t('settings.notifications.desktop.statusLabel')}
            </div>
            <div className="flex items-center gap-2 text-aux text-ink-fg-1">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${authStatusDotClass(
                  Boolean(sysStatus?.supported),
                  authState
                )}`}
              />
              <span>{authStatusText}</span>
            </div>
            {isDarwin && sysStatus?.supported !== false && (
              <div className="text-aux text-ink-fg-2">
                {t('settings.notifications.desktop.alertStyleHint')}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testingNotify || sysStatus?.supported === false}
              onClick={(): void => {
                void handleRequestPermission(false)
              }}
            >
              {t('settings.notifications.desktop.requestPermBtn')}
            </Button>
            {isDarwin && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(): void => {
                  void handleOpenSystemSettings()
                }}
              >
                {t('settings.notifications.desktop.openSystemSettingsBtn')}
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ink-border-soft pt-3">
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium text-ink-fg">
              {t('settings.notifications.desktop.trayLabel')}
            </div>
            <div className="text-aux text-ink-fg-2">
              {t('settings.notifications.desktop.trayHelper')}
            </div>
          </div>
          <Switch
            checked={settings?.trayEnabled ?? true}
            disabled={settings === null || savingDesktop}
            onCheckedChange={(checked): void => {
              void patchDesktop({ trayEnabled: checked })
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ink-border-soft pt-3">
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium text-ink-fg">
              {t('settings.notifications.desktop.dockBadgeLabel')}
            </div>
            <div className="text-aux text-ink-fg-2">
              {t('settings.notifications.desktop.dockBadgeHelper')}
            </div>
          </div>
          <Switch
            checked={settings?.dockBadgeEnabled ?? true}
            disabled={settings === null || savingDesktop}
            onCheckedChange={(checked): void => {
              void patchDesktop({ dockBadgeEnabled: checked })
            }}
          />
        </div>
      </Section>

      {/* 2. 分场景通知渠道与防重复 */}
      <Section
        title={t('settings.notifications.channels.title')}
        helper={t('settings.notifications.channels.helper')}
      >
        {/* 防重复打扰开关 */}
        <div className="space-y-3 py-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink-fg">
                {t('settings.notifications.channels.suppressFocusedLabel')}
              </div>
              <div className="text-aux text-ink-fg-2">
                {t('settings.notifications.channels.suppressFocusedHelper')}
              </div>
            </div>
            <Switch
              checked={prefs.suppressBannerWhenFocused}
              disabled={savingPrefs}
              onCheckedChange={(checked): void =>
                patchScenarioPrefs({ suppressBannerWhenFocused: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-ink-border-soft pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink-fg">
                {t('settings.notifications.channels.skipFeishuLabel')}
              </div>
              <div className="text-aux text-ink-fg-2">
                {t('settings.notifications.channels.skipFeishuHelper')}
              </div>
            </div>
            <Switch
              checked={prefs.skipBannerWhenFeishuSent}
              disabled={savingPrefs}
              onCheckedChange={(checked): void =>
                patchScenarioPrefs({ skipBannerWhenFeishuSent: checked })
              }
            />
          </div>
        </div>

        {/* 邮件通知 */}
        <div className="space-y-3 border-t border-ink-border-soft pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink-fg">
                {t('settings.notifications.channels.mailTitle')}
              </div>
              <div className="text-aux text-ink-fg-2">
                {t('settings.notifications.channels.mailHelper')}
              </div>
            </div>
            <DeliverySelect
              ariaLabel={t('settings.notifications.channels.mailTitle')}
              value={prefs.mailDelivery}
              disabled={savingPrefs}
              onChange={(next): void => patchScenarioPrefs({ mailDelivery: next })}
            />
          </div>

          {prefs.mailDelivery !== 'off' && (
            <div className="space-y-2.5 rounded-lg border border-ink-border-soft bg-ink-2/60 p-3">
              {mailBannerActive && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-aux text-ink-fg-1">
                    {t('settings.notifications.channels.mailScopeLabel')}
                  </span>
                  <select
                    aria-label={t('settings.notifications.channels.mailScopeLabel')}
                    value={prefs.mailScope}
                    disabled={savingPrefs}
                    onChange={(event): void =>
                      patchScenarioPrefs({
                        mailScope: event.target.value as MailNotificationScope
                      })
                    }
                    className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg"
                  >
                    <option value="urgent_and_important">
                      {t('settings.notifications.channels.mailScopeUrgentAndImportant')}
                    </option>
                    <option value="urgent_only">
                      {t('settings.notifications.channels.mailScopeUrgentOnly')}
                    </option>
                  </select>
                </div>
              )}

              <div
                className={`flex items-center justify-between gap-3 ${
                  mailBannerActive ? 'border-t border-ink-border-soft pt-2.5' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.notifications.channels.mailActionsLabel')}
                  </div>
                  <div className="text-aux text-ink-fg-2">
                    {t('settings.notifications.channels.mailActionsHelper')}
                  </div>
                </div>
                <Switch
                  checked={prefs.mailActionsEnabled}
                  disabled={savingPrefs}
                  onCheckedChange={(checked): void =>
                    patchScenarioPrefs({ mailActionsEnabled: checked })
                  }
                />
              </div>
            </div>
          )}
        </div>

        {/* 会议提醒与会前准备预设 */}
        <div className="space-y-3 border-t border-ink-border-soft pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink-fg">
                {t('settings.notifications.channels.meetingTitle')}
              </div>
              <div className="text-aux text-ink-fg-2">
                {t('settings.notifications.channels.meetingHelper')}
              </div>
            </div>
            <DeliverySelect
              ariaLabel={t('settings.notifications.channels.meetingTitle')}
              value={prefs.meetingDelivery}
              disabled={savingPrefs}
              onChange={(next): void => patchScenarioPrefs({ meetingDelivery: next })}
            />
          </div>

          {prefs.meetingDelivery !== 'off' && (
            <div className="space-y-2.5 rounded-lg border border-ink-border-soft bg-ink-2/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-aux text-ink-fg-1">
                  {t('settings.notifications.channels.meetingLeadLabel')}
                </span>
                <select
                  aria-label={t('settings.notifications.channels.meetingLeadLabel')}
                  value={prefs.meetingLeadMinutes}
                  disabled={savingPrefs}
                  onChange={(event): void =>
                    patchScenarioPrefs({
                      meetingLeadMinutes: Number.parseInt(event.target.value, 10) as 5 | 10 | 15 | 30
                    })
                  }
                  className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg"
                >
                  {([5, 10, 15, 30] as const).map((mins) => (
                    <option key={mins} value={mins}>
                      {t('settings.notifications.channels.meetingLeadMinutes', { count: mins })}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-ink-border-soft pt-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.notifications.channels.meetingActionsLabel')}
                  </div>
                  <div className="text-aux text-ink-fg-2">
                    {t('settings.notifications.channels.meetingActionsHelper')}
                  </div>
                </div>
                <Switch
                  checked={prefs.meetingActionsEnabled}
                  disabled={savingPrefs}
                  onCheckedChange={(checked): void =>
                    patchScenarioPrefs({ meetingActionsEnabled: checked })
                  }
                />
              </div>

              <div className="space-y-2.5 border-t border-ink-border-soft pt-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-aux font-medium text-ink-fg">
                      {t('settings.notifications.channels.meetingPrepLabel')}
                    </div>
                    <div className="text-aux text-ink-fg-2">
                      {t('settings.notifications.channels.meetingPrepHelper')}
                    </div>
                  </div>
                  <Switch
                    checked={prefs.meetingPrepEnabled}
                    disabled={savingPrefs}
                    onCheckedChange={(checked): void =>
                      patchScenarioPrefs({ meetingPrepEnabled: checked })
                    }
                  />
                </div>

                {prefs.meetingPrepEnabled && (
                  <div className="space-y-2 rounded-md border border-ink-border-soft bg-ink-1/70 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-aux text-ink-fg-1">
                        {t('settings.notifications.channels.meetingPrepModeLabel')}
                      </span>
                      <select
                        aria-label={t('settings.notifications.channels.meetingPrepModeLabel')}
                        value={prefs.meetingPrepMode}
                        disabled={savingPrefs}
                        onChange={(event): void =>
                          patchScenarioPrefs({
                            meetingPrepMode: event.target.value as MeetingPrepPresetMode
                          })
                        }
                        className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg"
                      >
                        <option value="on_demand">
                          {t('settings.notifications.channels.meetingPrepOnDemand')}
                        </option>
                        <option value="auto_before">
                          {t('settings.notifications.channels.meetingPrepAutoBefore')}
                        </option>
                      </select>
                    </div>

                    {prefs.meetingPrepMode === 'auto_before' && (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-border-soft pt-2">
                        <span className="text-aux text-ink-fg-1">
                          {t('settings.notifications.channels.meetingPrepLeadLabel')}
                        </span>
                        <select
                          aria-label={t('settings.notifications.channels.meetingPrepLeadLabel')}
                          value={prefs.meetingPrepLeadMinutes}
                          disabled={savingPrefs}
                          onChange={(event): void =>
                            patchScenarioPrefs({
                              meetingPrepLeadMinutes: Number.parseInt(event.target.value, 10) as
                                | 15
                                | 30
                                | 60
                                | 120
                            })
                          }
                          className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg"
                        >
                          {([15, 30, 60, 120] as const).map((mins) => (
                            <option key={mins} value={mins}>
                              {t('settings.notifications.channels.meetingLeadMinutes', {
                                count: mins
                              })}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 后台任务与系统告警 */}
        <div className="space-y-3 border-t border-ink-border-soft pt-4">
          <div>
            <div className="text-body font-medium text-ink-fg">
              {t('settings.notifications.channels.backgroundTitle')}
            </div>
            <div className="text-aux text-ink-fg-2">
              {t('settings.notifications.channels.backgroundHelper')}
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-border-soft bg-ink-2/60 px-3 py-2">
              <span className="text-aux text-ink-fg">
                {t('settings.notifications.channels.agentResultsLabel')}
              </span>
              <DeliverySelect
                ariaLabel={t('settings.notifications.channels.agentResultsLabel')}
                value={prefs.agentResultsDelivery}
                disabled={savingPrefs}
                onChange={(next): void => patchScenarioPrefs({ agentResultsDelivery: next })}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-border-soft bg-ink-2/60 px-3 py-2">
              <span className="text-aux text-ink-fg">
                {t('settings.notifications.channels.systemAlertsLabel')}
              </span>
              <DeliverySelect
                ariaLabel={t('settings.notifications.channels.systemAlertsLabel')}
                value={prefs.systemAlertsDelivery}
                disabled={savingPrefs}
                onChange={(next): void => patchScenarioPrefs({ systemAlertsDelivery: next })}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section
        title={t('settings.notifications.feishu.title')}
        helper={t('settings.notifications.feishu.helper')}
      >
        <EnvField
          envKey="FEISHU_NOTIFY_ENABLED"
          control="toggle"
          label={t('settings.notifications.feishu.enabled.label')}
          helper={t('settings.notifications.feishu.enabled.helper')}
        />
        <EnvField
          envKey="FEISHU_APP_ID"
          control="text"
          label={t('settings.notifications.feishu.appId.label')}
          helper={t('settings.notifications.feishu.appId.helper')}
        />
        <EnvField
          envKey="FEISHU_APP_SECRET"
          control="password"
          label={t('settings.notifications.feishu.appSecret.label')}
          helper={t('settings.notifications.feishu.appSecret.helper')}
        />
        <EnvField
          envKey="FEISHU_CHAT_ID"
          control="text"
          label={t('settings.notifications.feishu.chatId.label')}
          helper={t('settings.notifications.feishu.chatId.helper')}
        />
      </Section>

      {mattersEnabled ? (
        <Section
          title={t('settings.notifications.matters.title')}
          helper={t('settings.notifications.matters.helper')}
        >
          <label className="grid gap-2">
            <span className="text-body font-medium text-ink-fg">
              {t('settings.notifications.matters.level')}
            </span>
            <select
              value={notifyLevel.data?.level ?? 'high'}
              disabled={notifyLevel.isLoading || setNotifyLevel.isPending}
              onChange={(event): void =>
                setNotifyLevel.mutate(event.target.value as MatterNotifyLevel, {
                  onSuccess: () => toastSuccess(t('settings.notifications.matters.saved')),
                  onError: (error) =>
                    toastError(t('settings.notifications.matters.failed'), errorMessage(error))
                })
              }
              className="max-w-sm rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body"
            >
              <option value="high">{t('settings.notifications.matters.high')}</option>
              <option value="all">{t('settings.notifications.matters.all')}</option>
              <option value="off">{t('settings.notifications.matters.off')}</option>
            </select>
          </label>
        </Section>
      ) : null}

      <Section
        title={t('settings.notifications.alert.title')}
        helper={t('settings.notifications.alert.helper')}
      >
        <EnvField
          envKey="ALERT_ENABLED"
          control="toggle"
          label={t('settings.notifications.alert.enabled.label')}
          helper={t('settings.notifications.alert.enabled.helper')}
        />
        <EnvField
          envKey="ALERT_FEISHU_WEBHOOK_URL"
          control="text"
          label={t('settings.notifications.alert.webhookUrl.label')}
          helper={t('settings.notifications.alert.webhookUrl.helper')}
        />
        <EnvField
          envKey="ALERT_FEISHU_WEBHOOK_SECRET"
          control="password"
          label={t('settings.notifications.alert.webhookSecret.label')}
          helper={t('settings.notifications.alert.webhookSecret.helper')}
        />
        <EnvField
          envKey="ALERT_LEVELS"
          control="tag-list"
          label={t('settings.notifications.alert.levels.label')}
          helper={t('settings.notifications.alert.levels.helper')}
          placeholder="critical,error,warning"
        />
      </Section>
    </>
  )
}
