// Sprint 18 §PR D — Sync tab. 增量同步窗口 + 节拍 (reverse sync)。
// 日历配置已迁至「账户」Tab 的日历同步 Section (按 backend 分流 AppleScript / CalDAV)。
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
          defaultValue: '增量同步的时间窗口与轮询节拍。'
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
    </>
  )
}
