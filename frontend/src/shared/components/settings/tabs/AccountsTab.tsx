// Sprint 18 §PR D — Accounts tab. Notion + 邮件源 (applescript / davmail) + 签名.
//
// 邮件源 Section (重做): 顶部 SegmentedControl 切 MAILAGENT_BACKEND
// (applescript | davmail), 下方按选中源条件渲染对应字段面板。源切换 + 任何源字段
// 改动都需重启后端 (config.py 单例化, 不支持热 reload) → markRestartRequired。
// SYNC_MAILBOXES 两源共享 (从 SyncTab 移来); davmail 面板还吸纳了原 SyncTab 的
// 「自定义文件夹同步」整段 (FolderPicker 自带 davmail 门控)。
//
// web build (VITE_BUILD_TARGET==='web') 下 env.set 是 notImplemented → 源切换
// SegmentedControl disabled (同 EnvField 的 isWeb 只读处理); 字段面板里的 EnvField
// 自身也已各自 disabled, 这里只额外锁住切换控件本身。
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
import { SegmentedControl } from '@shared/components/ui/segmented'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { AdvancedDisclosure } from '../parts/AdvancedDisclosure'
import { FolderPicker } from '../parts/FolderPicker'

type MailBackend = 'applescript' | 'davmail'

/** 读单个 managed-env 值, 不订阅整个 store (仿 FolderPicker/RemoteAccessTab)。 */
function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
  )
}

/** 邮件源 Section — SegmentedControl 切后端 + 条件渲染源字段面板。 */
function MailSourceSection(): React.ReactElement {
  const { t } = useTranslation()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // Remote web (HttpApi) is read-only: env.set is notImplemented, so the source
  // toggle renders disabled. Mirror EnvField.tsx's VITE_BUILD_TARGET probe.
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  // 空值 → 默认 'applescript' (config.py 默认)。
  const rawBackend = useEnvValue('MAILAGENT_BACKEND')
  const backend: MailBackend = rawBackend === 'davmail' ? 'davmail' : 'applescript'

  // PoC 默认密钥开关: DAVMAIL_POC_MODE。后端 config.py 默认 False (未设 → 需真
  // cipher, 否则 BadPaddingException); 同面板的 DAVMAIL_POC_MODE toggle 用
  // EnvField isOn=storeValue==='true'||'1' (未设显 OFF)。三处必须一致: 未设 →
  // pocMode=false → cipher 字段显示。故只认显式 'true'/'1' 为开。
  const pocRaw = useEnvValue('DAVMAIL_POC_MODE')
  const pocMode = pocRaw === 'true' || pocRaw === '1'

  // 切源: 照 AiTab.handleToggleModel 范式 — await + 查 result.ok, 仅成功才
  // markRestartRequired (避免 banner 误报已变更), 失败 toastError。与
  // EnvField.persist / EnvSecretField 一致, 不 fire-and-forget。
  const onSourceChange = useCallback(
    async (next: MailBackend): Promise<void> => {
      if (next === backend) return
      const result = await applyEnvPatch({ MAILAGENT_BACKEND: next })
      if (result.ok) {
        if (result.changedKeys.length > 0) markRestartRequired(result.changedKeys)
      } else {
        toastError(
          t('settings.accounts.source.saveFail', { defaultValue: '切换邮件源失败' }),
          `${result.error.code}: ${result.error.message}`
        )
      }
    },
    [backend, markRestartRequired, t]
  )

  return (
    <Section
      title={t('settings.accounts.source.title', { defaultValue: '邮件源' })}
      helper={t('settings.accounts.source.helper', {
        defaultValue:
          '选择 MailAgent 如何读写你的邮件。切换源需重启后端生效，连接字段也都属于所选源。'
      })}
    >
      <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
        <div className="flex items-center gap-3">
          <span className="text-aux font-medium text-ink-fg shrink-0">
            {t('settings.accounts.source.pickLabel', { defaultValue: '邮件源选择:' })}
          </span>
          <SegmentedControl<MailBackend>
            value={backend}
            onChange={(v) => void onSourceChange(v)}
            fluid
            tone="accent"
            ariaLabel={t('settings.accounts.source.ariaLabel', { defaultValue: '邮件源' })}
            options={[
              {
                value: 'applescript',
                label: t('settings.accounts.source.applescript', { defaultValue: 'Mail.app' })
              },
              {
                value: 'davmail',
                label: t('settings.accounts.source.davmail', { defaultValue: 'DavMail' })
              }
            ]}
            className={isWeb ? 'pointer-events-none opacity-60' : undefined}
          />
        </div>
      </div>

      {backend === 'applescript' ? (
        <>
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
          <EnvField
            envKey="SYNC_MAILBOXES"
            control="tag-list"
            label={t('settings.sync.mailboxes.label')}
            helper={t('settings.sync.mailboxes.helper')}
            placeholder={t('settings.sync.mailboxes.placeholder') ?? undefined}
          />
        </>
      ) : (
        <>
          <EnvField
            envKey="USER_EMAIL"
            control="text"
            label={t('settings.accounts.davmail.userEmail.label', {
              defaultValue: 'IMAP/SMTP 登录名'
            })}
            helper={t('settings.accounts.davmail.userEmail.helper', {
              defaultValue: 'DavMail 用它作 IMAP/SMTP 登录名（= USER_EMAIL）'
            })}
          />
          <EnvField
            envKey="DAVMAIL_POC_MODE"
            control="toggle"
            label={t('settings.accounts.davmail.pocMode.label', {
              defaultValue: '使用 PoC 默认密钥'
            })}
            helper={t('settings.accounts.davmail.pocMode.helper', {
              defaultValue: '开启则用内置共享密钥（DAVMAIL_POC_MODE=true）；关闭需手填 cipher key。'
            })}
          />
          {!pocMode && (
            <EnvField
              envKey="DAVMAIL_POC_CIPHER_KEY"
              control="password"
              label={t('settings.accounts.davmail.cipherKey.label', {
                defaultValue: 'Cipher Key'
              })}
              helper={t('settings.accounts.davmail.cipherKey.helper', {
                defaultValue: 'DavMail OAuth cipher 密钥，写入 .env（不进系统钥匙串）。'
              })}
            />
          )}
          <EnvField
            envKey="SYNC_MAILBOXES"
            control="tag-list"
            label={t('settings.sync.mailboxes.label')}
            helper={t('settings.sync.mailboxes.helper')}
            placeholder={t('settings.sync.mailboxes.placeholder') ?? undefined}
          />
          <AdvancedDisclosure
            label={t('settings.accounts.davmail.advanced.title', {
              defaultValue: '高级连接'
            })}
            helper={t('settings.accounts.davmail.advanced.helper', {
              defaultValue: 'davmail 桥 host / 端口；默认 127.0.0.1 / 1143 / 1025 / 1080。'
            })}
          >
            <EnvField
              envKey="DAVMAIL_HOST"
              control="text"
              label={t('settings.accounts.davmail.host.label', { defaultValue: 'DavMail Host' })}
              helper={t('settings.accounts.davmail.host.helper', {
                defaultValue: 'davmail 桥监听地址，默认 127.0.0.1。'
              })}
              placeholder="127.0.0.1"
            />
            <EnvField
              envKey="DAVMAIL_IMAP_PORT"
              control="number"
              label={t('settings.accounts.davmail.imapPort.label', { defaultValue: 'IMAP 端口' })}
              helper={t('settings.accounts.davmail.imapPort.helper', {
                defaultValue: '默认 1143。'
              })}
              min={1}
              max={65535}
            />
            <EnvField
              envKey="DAVMAIL_SMTP_PORT"
              control="number"
              label={t('settings.accounts.davmail.smtpPort.label', { defaultValue: 'SMTP 端口' })}
              helper={t('settings.accounts.davmail.smtpPort.helper', {
                defaultValue: '默认 1025。'
              })}
              min={1}
              max={65535}
            />
            <EnvField
              envKey="DAVMAIL_CALDAV_PORT"
              control="number"
              label={t('settings.accounts.davmail.caldavPort.label', {
                defaultValue: 'CalDAV 端口'
              })}
              helper={t('settings.accounts.davmail.caldavPort.helper', {
                defaultValue: '日历同步用，默认 1080。'
              })}
              min={1}
              max={65535}
            />
            <EnvField
              envKey="DAVMAIL_DRAFTS_FOLDER"
              control="text"
              label={t('settings.accounts.davmail.draftsFolder.label', {
                defaultValue: '草稿箱文件夹名'
              })}
              helper={t('settings.accounts.davmail.draftsFolder.helper', {
                defaultValue: '留空自动探测；仅服务器草稿箱名非标准时才需手填。'
              })}
            />
            <EnvField
              envKey="DAVMAIL_ARCHIVE_SENT"
              control="toggle"
              label={t('settings.accounts.davmail.archiveSent.label', {
                defaultValue: '发送后归档到已发送'
              })}
              helper={t('settings.accounts.davmail.archiveSent.helper', {
                defaultValue: '开启后通过 SMTP 发出的邮件会写入已发送文件夹。'
              })}
            />
            <EnvField
              envKey="DAVMAIL_SENT_FOLDER"
              control="text"
              label={t('settings.accounts.davmail.sentFolder.label', {
                defaultValue: '已发送文件夹名'
              })}
              helper={t('settings.accounts.davmail.sentFolder.helper', {
                defaultValue: '留空自动探测；仅在「发送后归档」开启且服务器名非标准时才需手填。'
              })}
            />
          </AdvancedDisclosure>
          <EnvField
            envKey="DRAFTS_SYNC_ENABLED"
            control="toggle"
            label={t('settings.accounts.davmail.draftsSync.label', {
              defaultValue: '草稿箱同步'
            })}
            helper={t('settings.accounts.davmail.draftsSync.helper', {
              defaultValue: '把 Exchange 草稿箱同步进本地列表（仅本地，不进 Notion / AI / 飞书）。'
            })}
          />
          {/* 自定义文件夹同步 — 从 SyncTab 整段移来。davmail-only, 走完整 pipeline
              (AI/Notion/搜索)。FolderPicker 自带 backend 门控 (非 davmail 显 veil)。 */}
          <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
            <div className="text-aux font-medium text-ink-fg">
              {t('settings.folder.section.title', { defaultValue: '自定义文件夹同步' })}
            </div>
            <div className="text-meta text-ink-fg-2 mt-0.5 mb-3">
              {t('settings.folder.section.helper', {
                defaultValue:
                  '选择要同步进 MailAgent 的文件夹；邮件将享受 AI 分类、Notion 同步、全文搜索等完整能力。默认一个不选。'
              })}
            </div>
            <FolderPicker />
          </div>
          <EnvField
            envKey="FOLDER_SYNC_PAST_DAYS"
            control="number"
            label={t('settings.folder.window.pastDays.label', {
              defaultValue: '首次同步窗口（天）'
            })}
            helper={t('settings.folder.window.pastDays.helper', {
              defaultValue: '只拉最近 N 天；越大首次越慢、占空间越多。'
            })}
            min={1}
            max={3650}
          />
          <EnvField
            envKey="FOLDER_SYNC_MAX_MESSAGES"
            control="number"
            label={t('settings.folder.window.maxMessages.label', {
              defaultValue: '单文件夹上限（封）'
            })}
            helper={t('settings.folder.window.maxMessages.helper', {
              defaultValue: '防极端大邮箱；超出按时间降序截断。'
            })}
            min={100}
            max={50000}
          />
        </>
      )}
    </Section>
  )
}

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
          defaultValue: 'Notion 集成凭据与邮件源账户配置。'
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

      <MailSourceSection />

      <SignatureSection />
    </>
  )
}
