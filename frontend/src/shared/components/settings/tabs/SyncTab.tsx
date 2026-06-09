// Sprint 18 §PR D — Sync tab. SQLite radar + reverse sync + calendar 同步配置.
// 全部走 .env, restart=yes (config.py 单例化, 不支持热 reload).

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { FolderPicker } from '../parts/FolderPicker'

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

      {/* 多文件夹同步 (P3) — 自定义 Exchange 文件夹白名单。davmail-only, 走完整
          pipeline (AI/Notion/搜索)。动态文件夹树 (FolderPicker) 实时从后端拉取,
          区别于纯文本 EnvField。窗口配置 (首次窗口 + 单文件夹上限) 用 EnvField。 */}
      <Section
        title={t('settings.folder.section.title', { defaultValue: '自定义文件夹同步' })}
        meta="davmail"
        helper={t('settings.folder.section.helper', {
          defaultValue:
            '选择要同步进 MailAgent 的文件夹；邮件将享受 AI 分类、Notion 同步、全文搜索等完整能力。默认一个不选。'
        })}
      >
        <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
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
