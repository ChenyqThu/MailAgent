// Sprint 18 §PR D — Sync tab. SQLite radar + reverse sync + calendar 同步配置.
// 全部走 .env, restart=yes (config.py 单例化, 不支持热 reload).

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

export function SyncTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        eyebrow={t('settings.sync.page.eyebrow', { defaultValue: 'SYNC' })}
        title={t('settings.sync.page.title', { defaultValue: '同步' })}
        description={t('settings.sync.page.intro', {
          defaultValue: 'SQLite radar 同步窗口、节拍与日历采集范围。'
        })}
      />
      <Section title={t('settings.sync.window.title')} helper={t('settings.sync.window.helper')}>
        <EnvField
          envKey="SYNC_DATE_MODE"
          control="select"
          label={t('settings.sync.dateMode.label')}
          helper={t('settings.sync.dateMode.helper')}
          options={[
            { value: 'fixed', label: t('settings.sync.dateMode.fixed') },
            { value: 'relative', label: t('settings.sync.dateMode.relative') }
          ]}
        />
        <EnvField
          envKey="SYNC_START_DATE"
          control="date"
          label={t('settings.sync.startDate.label')}
          helper={t('settings.sync.startDate.helper')}
        />
        <EnvField
          envKey="SYNC_LOOKBACK_DAYS"
          control="number"
          label={t('settings.sync.lookbackDays.label')}
          helper={t('settings.sync.lookbackDays.helper')}
          min={1}
          max={365}
        />
        <EnvField
          envKey="SYNC_MAILBOXES"
          control="tag-list"
          label={t('settings.sync.mailboxes.label')}
          helper={t('settings.sync.mailboxes.helper')}
          placeholder={t('settings.sync.mailboxes.placeholder') ?? undefined}
        />
      </Section>

      <Section title={t('settings.sync.cadence.title')}>
        <EnvField
          envKey="RADAR_POLL_INTERVAL"
          control="number"
          label={t('settings.sync.radarInterval.label')}
          helper={t('settings.sync.radarInterval.helper')}
          min={1}
          max={60}
        />
        <EnvField
          envKey="REVERSE_SYNC_INTERVAL"
          control="number"
          label={t('settings.sync.reverseInterval.label')}
          helper={t('settings.sync.reverseInterval.helper')}
          min={5}
          max={300}
        />
        <EnvField
          envKey="HEALTH_CHECK_INTERVAL"
          control="number"
          label={t('settings.sync.healthInterval.label')}
          helper={t('settings.sync.healthInterval.helper')}
          min={60}
          max={86400}
        />
      </Section>

      {/* 文件夹同步 (存档 / 草稿箱) — FolderSyncWorker, davmail-only。独立于上方
          主收件箱同步: 纯展示, 不跑 AI/Notion。主开关 + 轮询间隔 + 存档窗口/上限。 */}
      <Section
        title={t('settings.sync.folder.title', { defaultValue: '文件夹同步（存档 / 草稿箱）' })}
        helper={t('settings.sync.folder.helper', {
          defaultValue:
            '把存档、草稿箱也同步到本地用于查看（仅 davmail 后端）。独立于上方主收件箱同步，纯展示，不跑 AI / Notion。'
        })}
      >
        <EnvField
          envKey="MAILBOX_FOLDER_SYNC_ENABLED"
          control="toggle"
          label={t('settings.sync.folder.enabled.label', { defaultValue: '同步存档 / 草稿箱' })}
          helper={t('settings.sync.folder.enabled.helper', {
            defaultValue: '默认关闭 · 仅 davmail 后端生效；开启后后台增量拉取 Archive / Drafts。'
          })}
        />
        <EnvField
          envKey="FOLDER_SYNC_POLL_INTERVAL_SEC"
          control="number"
          label={t('settings.sync.folder.interval.label', { defaultValue: '轮询间隔（秒）' })}
          helper={t('settings.sync.folder.interval.helper', {
            defaultValue: 'FolderSyncWorker 检查存档 / 草稿箱新邮件的间隔。'
          })}
          min={15}
          max={3600}
        />
        <EnvField
          envKey="ARCHIVE_SYNC_PAST_DAYS"
          control="number"
          label={t('settings.sync.folder.pastDays.label', { defaultValue: '存档同步窗口（天）' })}
          helper={t('settings.sync.folder.pastDays.helper', {
            defaultValue: '只拉最近 N 天的存档；越大首次越慢、占空间越多。'
          })}
          min={1}
          max={3650}
        />
        <EnvField
          envKey="ARCHIVE_SYNC_MAX_MESSAGES"
          control="number"
          label={t('settings.sync.folder.maxMessages.label', {
            defaultValue: '存档同步上限（封）'
          })}
          helper={t('settings.sync.folder.maxMessages.helper', {
            defaultValue: '防极端大邮箱；超出按时间降序截断。'
          })}
          min={100}
          max={50000}
        />
      </Section>

      <Section title={t('settings.sync.calendar.title')}>
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
      </Section>
    </>
  )
}
