// Sprint 18 §PR D — Notifications tab. 飞书应用机器人 (重要邮件推送) +
// 飞书告警机器人 (服务异常). 两套不同的 webhook 配置,共享一个 Tab.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

export function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
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
