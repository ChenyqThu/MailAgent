// Sprint 18 §PR D — Notifications tab. 飞书应用机器人 (重要邮件推送) +
// 飞书告警机器人 (服务异常). 两套不同的 webhook 配置,共享一个 Tab.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { useMatterFlags, useNotifyLevel, useSetNotifyLevel } from '@shared/components/matters/hooks'
import type { MatterNotifyLevel } from '@shared/api/types/matter'
import { toastError, toastSuccess } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'

export function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const { mattersEnabled } = useMatterFlags()
  const notifyLevel = useNotifyLevel(mattersEnabled)
  const setNotifyLevel = useSetNotifyLevel()

  return (
    <>
      <PageHeader
        eyebrow={t('settings.notifications.page.eyebrow', { defaultValue: 'NOTIFICATIONS' })}
        title={t('settings.notifications.page.title', { defaultValue: '通知' })}
        description={t('settings.notifications.page.intro', {
          defaultValue: '飞书应用机器人推送重要邮件 · 告警机器人推送服务异常。'
        })}
      />
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
        <Section title={t('settings.notifications.matters.title')} helper={t('settings.notifications.matters.helper')}>
          <label className="grid gap-2">
            <span className="text-body font-medium text-ink-fg">{t('settings.notifications.matters.level')}</span>
            <select
              value={notifyLevel.data?.level ?? 'high'}
              disabled={notifyLevel.isLoading || setNotifyLevel.isPending}
              onChange={(event) => setNotifyLevel.mutate(event.target.value as MatterNotifyLevel, {
                onSuccess: () => toastSuccess(t('settings.notifications.matters.saved')),
                onError: (error) => toastError(t('settings.notifications.matters.failed'), errorMessage(error))
              })}
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
