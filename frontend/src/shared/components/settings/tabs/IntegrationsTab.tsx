// Sprint 18 §PR D — Integrations tab. 三类外挂模块的 ENV 配置:
//   1. Project Progress (项目周报邮件 → Notion 项目库)
//   2. Office Convert (docx/pptx → PDF, xlsx → CSV)
//   3. Stats Report + Dashboard + CLI auth
//
// CLI API key 走 <EnvSecretField> 双写 (keytar + .env): main 进程的
// cli_runner 从 keytar 注入 header, Python CLI 自己从 .env 读 (CRS-style
// rate-limit 双向校验).

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'

export function IntegrationsTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <Section
        title={t('settings.integrations.projectProgress.title')}
        helper={t('settings.integrations.projectProgress.helper')}
      >
        <EnvField
          envKey="PROJECT_PROGRESS_SYNC_ENABLED"
          control="toggle"
          label={t('settings.integrations.projectProgress.enabled.label')}
          helper={t('settings.integrations.projectProgress.enabled.helper')}
        />
        <EnvField
          envKey="PROJECT_PROGRESS_AUTO_SYNC_ENABLED"
          control="toggle"
          label={t('settings.integrations.projectProgress.autoSync.label')}
          helper={t('settings.integrations.projectProgress.autoSync.helper')}
        />
        <EnvField
          envKey="PROJECT_PROGRESS_DATABASE_ID"
          control="text"
          label={t('settings.integrations.projectProgress.databaseId.label')}
          helper={t('settings.integrations.projectProgress.databaseId.helper')}
        />
        <EnvField
          envKey="PROJECT_PROGRESS_FILTER_BU"
          control="text"
          label={t('settings.integrations.projectProgress.filterBu.label')}
          helper={t('settings.integrations.projectProgress.filterBu.helper')}
          placeholder="TPS-ENBU"
        />
        <EnvField
          envKey="PROJECT_PROGRESS_SUBJECT_PATTERN"
          control="text"
          label={t('settings.integrations.projectProgress.subjectPattern.label')}
          helper={t('settings.integrations.projectProgress.subjectPattern.helper')}
        />
        <EnvField
          envKey="PROJECT_PROGRESS_SENDER"
          control="text"
          label={t('settings.integrations.projectProgress.sender.label')}
          helper={t('settings.integrations.projectProgress.sender.helper')}
        />
      </Section>

      <Section
        title={t('settings.integrations.office.title')}
        helper={t('settings.integrations.office.helper')}
      >
        <EnvField
          envKey="OFFICE_CONVERT_ENABLED"
          control="toggle"
          label={t('settings.integrations.office.enabled.label')}
          helper={t('settings.integrations.office.enabled.helper')}
        />
      </Section>

      <Section
        title={t('settings.integrations.stats.title')}
        helper={t('settings.integrations.stats.helper')}
      >
        <EnvField
          envKey="STATS_REPORT_URL"
          control="text"
          label={t('settings.integrations.stats.url.label')}
          helper={t('settings.integrations.stats.url.helper')}
        />
        <EnvField
          envKey="STATS_REPORT_TOKEN"
          control="password"
          label={t('settings.integrations.stats.token.label')}
          helper={t('settings.integrations.stats.token.helper')}
        />
        <EnvField
          envKey="DASHBOARD_PASSWORD"
          control="password"
          label={t('settings.integrations.dashboard.password.label')}
          helper={t('settings.integrations.dashboard.password.helper')}
        />
      </Section>

      <Section
        title={t('settings.integrations.cli.title')}
        helper={t('settings.integrations.cli.helper')}
      >
        <EnvSecretField
          envKey="MAILAGENT_CLI_API_KEY"
          keytarSlot="cliApiKey"
          label={t('settings.integrations.cli.apiKey.label')}
          helper={t('settings.integrations.cli.apiKey.helper')}
        />
      </Section>
    </>
  )
}
