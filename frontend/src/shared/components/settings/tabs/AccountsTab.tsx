// Sprint 18 §PR D — Accounts tab. Notion + Mail.app 账户字段, 全部走 .env.
//
// USER_EMAIL 显示出来供 user 确认 — `loadUserEmailFromEnv` (Sprint 11) 仍是
// 唯一信号源, 此处通过 env:get 读. 修改后 Sidebar 的账户头像走 settings:get
// 二次读取 (持久 settings.userEmail 字段) 自动同步.
//
// 签名 (Signature) Section — PersistentSettings.signature, compose 工具栏「签名」
// 按钮在光标处插入。读写走 settings:get/set (与 IslandUpdatesTab autoDownload 同款
// mount 读初值 + onBlur 写回 precedent), 非 .env。

import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

/** 签名编辑框 — settings.signature (HTML/纯文本)。失焦保存; 空串存 null。 */
function SignatureSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  // null = 尚未加载完 (mount 读 settings.get())。
  const [value, setValue] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.settings
      .get()
      .then((s) => {
        if (!cancelled) setValue(s.signature ?? '')
      })
      .catch(() => {
        if (!cancelled) setValue('')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const save = useCallback(async () => {
    if (value === null) return
    setSaving(true)
    try {
      const trimmed = value.trim()
      const updated = await api.settings.set({ signature: trimmed === '' ? null : trimmed })
      setValue(updated.signature ?? '')
      toastSuccess(t('settings.accounts.signature.saved', { defaultValue: '签名已保存' }))
    } catch (err) {
      toastError(
        t('settings.accounts.signature.saveFail', { defaultValue: '签名保存失败' }),
        (err as Error).message
      )
    } finally {
      setSaving(false)
    }
  }, [api, value, t])

  return (
    <Section
      title={t('settings.accounts.signature.title', { defaultValue: '邮件签名' })}
      helper={t('settings.accounts.signature.helper', {
        defaultValue: '撰写邮件时点工具栏「签名」按钮，在光标处插入。支持纯文本或 HTML。'
      })}
    >
      <textarea
        value={value ?? ''}
        disabled={value === null || saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        rows={5}
        placeholder={
          t('settings.accounts.signature.placeholder', {
            defaultValue: '例如：\nLucien Chen\nOmada Networks'
          }) ?? undefined
        }
        aria-label={t('settings.accounts.signature.title', { defaultValue: '邮件签名' })}
        className="w-full rounded-lg border border-ink-border bg-ink-2/60 px-3 py-2.5 text-aux text-ink-fg placeholder:text-ink-fg-3 leading-relaxed resize-y outline-none transition-colors duration-fast focus:border-coral/40 scrollbar-thin disabled:opacity-60"
      />
    </Section>
  )
}

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

      <SignatureSection />
    </>
  )
}
