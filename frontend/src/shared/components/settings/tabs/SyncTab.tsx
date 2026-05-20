// Sprint 18 §PR D — Sync tab. SQLite radar + reverse sync + calendar 同步配置.
// 全部走 .env, restart=yes (config.py 单例化, 不支持热 reload).

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'

export function SyncTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
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
