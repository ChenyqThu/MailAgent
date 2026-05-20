// Sprint 18 §PR D — Accounts tab. Notion + Mail.app 账户字段, 全部走 .env.
//
// USER_EMAIL 显示出来供 user 确认 — `loadUserEmailFromEnv` (Sprint 11) 仍是
// 唯一信号源, 此处通过 env:get 读. 修改后 Sidebar 的账户头像走 settings:get
// 二次读取 (持久 settings.userEmail 字段) 自动同步.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

export function AccountsTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        eyebrow={t('settings.accounts.page.eyebrow', { defaultValue: 'ACCOUNTS' })}
        title={t('settings.accounts.page.title', { defaultValue: '账户' })}
        description={t('settings.accounts.page.intro', {
          defaultValue: 'Notion 集成凭据与 Mail.app 邮箱账户配置。'
        })}
      />
      <Section title={t('settings.accounts.notion.title')}>
        <EnvField
          envKey="NOTION_TOKEN"
          control="password"
          label={t('settings.accounts.notion.token.label')}
          helper={t('settings.accounts.notion.token.helper')}
          placeholder={t('settings.accounts.notion.token.placeholder') ?? undefined}
        />
        <EnvField
          envKey="EMAIL_DATABASE_ID"
          control="text"
          label={t('settings.accounts.notion.databaseId.label')}
          helper={t('settings.accounts.notion.databaseId.helper')}
        />
        <EnvField
          envKey="CALENDAR_DATABASE_ID"
          control="text"
          label={t('settings.accounts.notion.calendarDatabaseId.label')}
          helper={t('settings.accounts.notion.calendarDatabaseId.helper')}
        />
      </Section>

      <Section title={t('settings.accounts.mail.title')}>
        <EnvField
          envKey="USER_EMAIL"
          control="text"
          label={t('settings.accounts.mail.userEmail.label')}
          helper={t('settings.accounts.mail.userEmail.helper')}
        />
        <EnvField
          envKey="MAIL_ACCOUNT_NAME"
          control="text"
          label={t('settings.accounts.mail.accountName.label')}
          helper={t('settings.accounts.mail.accountName.helper')}
        />
        <EnvField
          envKey="MAIL_INBOX_NAME"
          control="text"
          label={t('settings.accounts.mail.inboxName.label')}
          helper={t('settings.accounts.mail.inboxName.helper')}
        />
        <EnvField
          envKey="MAIL_SENT_NAME"
          control="text"
          label={t('settings.accounts.mail.sentName.label')}
          helper={t('settings.accounts.mail.sentName.helper')}
        />
      </Section>
    </>
  )
}
