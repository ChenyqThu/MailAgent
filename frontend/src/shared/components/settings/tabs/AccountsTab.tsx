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
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
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

/** Notion 未配置提示 (07-12 P3b 方案 C 状态显式化)。token 或邮件库 ID 空 → Notion
 *  镜像/项目周报/日历同步停用, 显式告知避免被误判成同步故障。仅 env store ready 后
 *  判定 (防加载态误闪)。NOTION_TOKEN 是 secret key: env:get 已设时回 '***'、未设回
 *  ''—— 空值判定不受脱敏影响。判据与后端 config.notion_enabled() 同口径 (双非空)。 */
function NotionDisabledNotice(): React.ReactElement | null {
  const { t } = useTranslation()
  const ready = useEnvStore((s) => s.state.status === 'ready')
  const token = useEnvValue('NOTION_TOKEN')
  const dbId = useEnvValue('EMAIL_DATABASE_ID')
  if (!ready || (token.trim() !== '' && dbId.trim() !== '')) return null
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5"
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5 text-warn" aria-hidden="true" />
      <p className="text-aux text-ink-fg-1 leading-relaxed">
        {t('settings.accounts.notion.disabledNotice', {
          defaultValue:
            'Notion 未配置：镜像同步 / 项目周报 / 日历同步已停用，邮件仅在本地同步（列表、搜索、AI 分类等本地功能不受影响）。填齐 Token 与邮件数据库 ID 并重启后启用。'
        })}
      </p>
    </div>
  )
}

/** davmail.folderSizeLimit 落地状态 — 这个设置**是否真的生效**的唯一诚实信号。
 *
 *  链路: .env DAVMAIL_FOLDER_SIZE_LIMIT → mail-sync 启动时写进
 *  `<DAVMAIL_ROOT>/config/davmail.properties` → **重启 DavMail 桥后**才被读取。
 *  DAVMAIL_ROOT 没配 (打包 .app 的默认解析会落进 site-packages) 时文件根本不存在,
 *  这个输入框就是不生效 —— 必须显式说出来, 不能让它看起来像保存成功了。
 *
 *  状态源 = sync_state davmail.folder_size_limit.*, 经 admin.davmailHealth 读
 *  (与 DavMailHealthCard 同 queryKey, 同页不重复请求)。后端没跑过同步 (老版本 /
 *  非 davmail 模式) → 字段为空 → 不渲染。 */
function FolderSizeLimitStatus(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const { data } = useQuery({
    queryKey: qk.admin.davmailHealth(),
    queryFn: () => api.admin.davmailHealth(),
    staleTime: 30_000,
    retry: false
  })

  const status = data?.folder_size_limit_status
  if (!status) return null

  const path = data?.folder_size_limit_path ?? ''
  const desired = data?.folder_size_limit_desired ?? 0
  const fileValue = data?.folder_size_limit_file_value

  const problem = status === 'file_missing' || status === 'error'
  let text: string
  if (status === 'file_missing') {
    text = t('settings.accounts.davmail.folderSizeLimit.status.fileMissing', {
      path,
      desired,
      defaultValue:
        '未找到 DavMail 配置文件，此设置当前不生效：{path}。请在 .env 配 DAVMAIL_ROOT 指向 DavMail 部署目录，或手动在 davmail.properties 里加一行 davmail.folderSizeLimit={desired}。'
    })
  } else if (status === 'error') {
    text = t('settings.accounts.davmail.folderSizeLimit.status.error', {
      path,
      defaultValue:
        '写入 DavMail 配置文件失败，此设置当前可能不生效：{path}（失败原因见后端日志）。'
    })
  } else if (status === 'updated') {
    text = t('settings.accounts.davmail.folderSizeLimit.status.updated', {
      path,
      desired,
      defaultValue:
        '已写入 DavMail 配置文件（{path} → davmail.folderSizeLimit={desired}）。DavMail 只在启动时读配置，重启 DavMail 桥（pm2 restart davmail-poc）后才生效。'
    })
  } else if (status === 'disabled') {
    text =
      fileValue === null || fileValue === undefined
        ? t('settings.accounts.davmail.folderSizeLimit.status.disabledUnset', {
            defaultValue:
              '已设为 0：MailAgent 不管理这一项，DavMail 配置文件里也没有设置它（大邮箱有停摆风险）。'
          })
        : t('settings.accounts.davmail.folderSizeLimit.status.disabled', {
            value: fileValue,
            defaultValue:
              '已设为 0：MailAgent 不管理这一项，DavMail 用配置文件里自己的值（当前 {value}）。'
          })
  } else {
    text = t('settings.accounts.davmail.folderSizeLimit.status.unchanged', {
      path,
      value: fileValue ?? desired,
      defaultValue: 'DavMail 配置文件里已是 {value} 封（{path}），无需改动。'
    })
  }

  return (
    <div className="px-[var(--settings-tile-px,1rem)] pb-[var(--settings-tile-py,0.875rem)] -mt-1">
      <div
        role="status"
        className={cn(
          'flex items-start gap-2 rounded-lg border px-2.5 py-2',
          problem ? 'border-warn/30 bg-warn/10' : 'border-ink-border bg-ink-2/50'
        )}
      >
        {problem ? (
          <AlertTriangle size={13} className="shrink-0 mt-0.5 text-warn" aria-hidden="true" />
        ) : (
          <Info size={13} className="shrink-0 mt-0.5 text-ink-fg-2" aria-hidden="true" />
        )}
        <p className={cn('text-aux leading-relaxed', problem ? 'text-ink-fg-1' : 'text-ink-fg-2')}>
          {text}
        </p>
      </div>
    </div>
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
          {/* davmail.folderSizeLimit —— 2026-07-24 大邮箱停摆事故的可配置化。
              值写进 davmail.properties (Python 启动时同步), 下方状态行说明到底
              写没写进去 / 要不要重启 DavMail, 别让它看起来"保存了就生效了"。 */}
          <EnvField
            envKey="DAVMAIL_FOLDER_SIZE_LIMIT"
            control="number"
            label={t('settings.accounts.davmail.folderSizeLimit.label', {
              defaultValue: 'IMAP 文件夹视图上限（封）'
            })}
            helper={t('settings.accounts.davmail.folderSizeLimit.helper', {
              defaultValue:
                '只让 DavMail 在 IMAP 里暴露每个文件夹最近 N 封邮件。大邮箱（超过 1 万封）不限制时，每次同步都要让 DavMail 经 EWS 把整个文件夹枚举一遍——慢到超时，整条同步链停摆。代价：窗口外更早的邮件在 IMAP 层不可见（已同步到本地的历史邮件不受影响，只影响增量同步和标记/归档等写操作能触达的范围）。默认 500；填 0 表示不由 MailAgent 管理这一项。'
            })}
            min={0}
            max={100000}
          />
          <FolderSizeLimitStatus />
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
          {/* 别处标已读同步 (issue #60) — 后端 inbound_read_reconcile_enabled 早已
              实现 (src/config.py), 此前只能手改 .env。默认关闭; 不暴露
              INTERVAL_SEC (300s 背后是"绝不挂 5s radar poll"的工程判断, 不是给
              用户按邮箱大小调的旋钮)。 */}
          <EnvField
            envKey="MAILAGENT_INBOUND_READ_RECONCILE_ENABLED"
            control="toggle"
            label={t('settings.accounts.davmail.readReconcile.label', {
              defaultValue: '别处已读同步'
            })}
            helper={t('settings.accounts.davmail.readReconcile.helper', {
              defaultValue:
                '在 Outlook 或网页版 Outlook 里把邮件标为已读后，本地收件箱的未读数会跟着更新（仅收件箱，仅「未读→已读」单向，不影响已读→未读或旗标）。每 5 分钟检查一次，默认关闭。'
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

/** 日历同步 Section — 按 backend 条件渲染（从 SyncTab 迁来，归账户）。
 *  applescript 走本机 Calendar.app（AppleScript / EventKit）；davmail 走 CalDAV
 *  （把 Exchange 日历拉进本地），端口在上方「邮件源 · 高级连接 · CalDAV 端口」。 */
function CalendarSyncSection(): React.ReactElement {
  const { t } = useTranslation()
  const rawBackend = useEnvValue('MAILAGENT_BACKEND')
  const backend: MailBackend = rawBackend === 'davmail' ? 'davmail' : 'applescript'
  return (
    <Section
      title={t('settings.sync.calendar.title', { defaultValue: '日历同步' })}
      helper={
        backend === 'davmail'
          ? t('settings.accounts.calendar.helperDavmail', {
              defaultValue:
                'DavMail 经 CalDAV 把 Exchange 日历同步进本地（端口见上方「高级连接 · CalDAV 端口」）。'
            })
          : t('settings.accounts.calendar.helperApplescript', {
              defaultValue: 'Mail.app 经 AppleScript / EventKit 读取本机 Calendar.app。'
            })
      }
    >
      {backend === 'applescript' ? (
        <>
          <EnvField
            envKey="CALENDAR_SYNC_MODE"
            control="select"
            label={t('settings.sync.calendar.syncMode.label')}
            helper={t('settings.sync.calendar.syncMode.helper')}
            options={[
              { value: 'applescript', label: 'AppleScript' },
              { value: 'eventkit', label: 'EventKit' }
            ]}
          />
          <EnvField
            envKey="CALENDAR_PAST_DAYS"
            control="number"
            label={t('settings.sync.calendar.pastDays.label')}
            helper={t('settings.sync.calendar.pastDays.helper')}
            min={0}
            max={365}
          />
          <EnvField
            envKey="CALENDAR_FUTURE_DAYS"
            control="number"
            label={t('settings.sync.calendar.futureDays.label')}
            helper={t('settings.sync.calendar.futureDays.helper')}
            min={0}
            max={365}
          />
        </>
      ) : (
        <>
          <EnvField
            envKey="CALENDAR_CALDAV_SYNC_ENABLED"
            control="toggle"
            label={t('settings.accounts.calendar.caldav.enabled.label', {
              defaultValue: '启用 CalDAV 日历同步'
            })}
            helper={t('settings.accounts.calendar.caldav.enabled.helper', {
              defaultValue: '开启后从 DavMail CalDAV 周期性拉取 Exchange 日历进本地。'
            })}
          />
          <EnvField
            envKey="CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC"
            control="number"
            label={t('settings.accounts.calendar.caldav.poll.label', {
              defaultValue: '轮询间隔（秒）'
            })}
            helper={t('settings.accounts.calendar.caldav.poll.helper', {
              defaultValue: '每隔多少秒检查一次日历变化，默认 60。'
            })}
            min={10}
            max={3600}
          />
          <EnvField
            envKey="CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS"
            control="number"
            label={t('settings.accounts.calendar.caldav.pastDays.label', {
              defaultValue: '过去多少天'
            })}
            helper={t('settings.accounts.calendar.caldav.pastDays.helper', {
              defaultValue: '回溯历史事件窗口，默认 30。'
            })}
            min={0}
            max={3650}
          />
          <EnvField
            envKey="CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS"
            control="number"
            label={t('settings.accounts.calendar.caldav.futureDays.label', {
              defaultValue: '未来多少天'
            })}
            helper={t('settings.accounts.calendar.caldav.futureDays.helper', {
              defaultValue: '向前扩展窗口，默认 180。'
            })}
            min={0}
            max={3650}
          />
          {/* Lane 2 #4 — 会前提醒提前量。纯偏好、零风险; 提醒挂 CalendarSyncWorker
              (davmail CalDAV 路径), 故只在 davmail 分支渲染; 无岛时静默不提醒。 */}
          <EnvField
            envKey="CALENDAR_REMINDER_LEAD_MINUTES"
            control="number"
            label={t('settings.accounts.calendar.reminderLead.label', {
              defaultValue: '会前提醒提前量（分钟）'
            })}
            helper={t('settings.accounts.calendar.reminderLead.helper', {
              defaultValue:
                '日程开始前多少分钟在灵动岛弹提醒卡，默认 10。需启用上方 CalDAV 日历同步和灵动岛；同一场会议只提醒一次。'
            })}
            min={0}
            max={720}
            placeholder="10"
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
        errorMessage(err)
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
            defaultValue: '例如：\n<用户姓名>\n<公司或团队名称>'
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
        <NotionDisabledNotice />
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

      <CalendarSyncSection />

      <SignatureSection />
    </>
  )
}
