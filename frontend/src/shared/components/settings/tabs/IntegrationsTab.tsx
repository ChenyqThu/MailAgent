// Sprint 18 §PR D — Integrations tab. 外挂模块的 ENV 配置:
//   1. Office Convert (docx/pptx → PDF, xlsx → CSV)
//   2. Stats Report + Dashboard + CLI auth
// (Project Progress 已随 v1.3.0 dogfood 收编进 Agents 页抽屉, 见下方注释)
//
// CLI API key 走 <EnvSecretField> 双写 (keytar + .env): main 进程的
// cli_runner 从 keytar 注入 header, Python CLI 自己从 .env 读 (CRS-style
// rate-limit 双向校验).

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'
import { AdvancedDisclosure } from '../parts/AdvancedDisclosure'

export function IntegrationsTab(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        eyebrow={t('settings.integrations.page.eyebrow', { defaultValue: 'INTEGRATIONS' })}
        title={t('settings.integrations.page.title', { defaultValue: '集成' })}
        description={t('settings.integrations.page.intro', {
          defaultValue: '项目周报同步、Office 文档转换、看板上报与 CLI 鉴权。'
        })}
      />
      <Section
        title={t('settings.integrations.kos.title', { defaultValue: '知识大脑 (KOS)' })}
        helper={
          <>
            {t('settings.integrations.kos.helper', {
              defaultValue:
                'KOS 让 AI 在对话中跨邮件 / 产品知识检索、召回历史事实、找专家。需对接一套自部署的 gbrain 知识库服务：去 '
            })}
            <a
              href="https://github.com/garrytan/gbrain"
              target="_blank"
              rel="noopener noreferrer"
              className="text-coral hover:underline"
            >
              garrytan/gbrain
            </a>
            {t('settings.integrations.kos.helperSuffix', {
              defaultValue:
                ' 部署服务并申请 OAuth 凭据，填入下方。未对接（凭据缺失）时对话不会注入 KOS 工具。'
            })}
          </>
        }
      >
        <EnvField
          envKey="MAILAGENT_KOS_CONSUMER_ENABLED"
          control="toggle"
          label={t('settings.integrations.kos.enabled.label', { defaultValue: '启用 KOS 工具' })}
          helper={t('settings.integrations.kos.enabled.helper', {
            defaultValue:
              '开启后，对话 AI 可调用 kos_query / kos_recall / kos_get_page 等知识大脑工具（需下方凭据齐全）。'
          })}
        />
        <EnvField
          envKey="KOS_MCP_BASE"
          control="text"
          label={t('settings.integrations.kos.endpoint.label', { defaultValue: 'KOS 服务地址' })}
          helper={t('settings.integrations.kos.endpoint.helper', {
            defaultValue: 'gbrain 服务的 MCP endpoint，例如 https://kos.example.com。'
          })}
          placeholder="https://kos.example.com"
        />
        <EnvField
          envKey="KOS_OAUTH_CLIENT_ID"
          control="text"
          label={t('settings.integrations.kos.clientId.label', { defaultValue: 'OAuth Client ID' })}
          helper={t('settings.integrations.kos.clientId.helper', {
            defaultValue: 'gbrain 颁发的客户端 ID（gbrain_cl_ 前缀）。'
          })}
          placeholder="gbrain_cl_..."
        />
        <EnvField
          envKey="KOS_OAUTH_CLIENT_SECRET"
          control="password"
          label={t('settings.integrations.kos.clientSecret.label', {
            defaultValue: 'OAuth Client Secret'
          })}
          helper={t('settings.integrations.kos.clientSecret.helper', {
            defaultValue:
              'gbrain 颁发的客户端密钥（gbrain_cs_ 前缀），仅本机 .env 存储，不回传界面。'
          })}
        />
        <AdvancedDisclosure
          label={t('settings.integrations.kos.advanced.label', { defaultValue: '高级' })}
        >
          <EnvField
            envKey="MAILAGENT_KOS_INGEST_ENABLED"
            control="toggle"
            label={t('settings.integrations.kos.ingest.label', { defaultValue: '推送邮件入库' })}
            helper={t('settings.integrations.kos.ingest.helper', {
              defaultValue: '邮件同步完成后异步推送进 KOS（producer），供日后检索。默认关。'
            })}
          />
          <EnvField
            envKey="MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED"
            control="toggle"
            label={t('settings.integrations.kos.l1.label', { defaultValue: '发件人热记忆预取' })}
            helper={t('settings.integrations.kos.l1.helper', {
              defaultValue:
                '对话开始时按发件人预取 KOS 摘要注入系统提示，让 AI 更懂上下文。默认关。'
            })}
          />
          <EnvField
            envKey="MAILAGENT_KOS_TIME_DECAY_ENABLED"
            control="toggle"
            label={t('settings.integrations.kos.timeDecay.label', { defaultValue: '时间衰减重排' })}
            helper={t('settings.integrations.kos.timeDecay.helper', {
              defaultValue: 'kos_query 命中结果按 14 天半衰期做时间衰减重排（更偏好近期）。默认开。'
            })}
          />
        </AdvancedDisclosure>
      </Section>

      <Section
        title={t('settings.integrations.websearch.title', { defaultValue: 'Web 搜索' })}
        helper={t('settings.integrations.websearch.helper', {
          defaultValue:
            'AI 对话里的 web_search 工具默认走 DuckDuckGo，国内网络被阻断不可用。填入 Tavily API key 即改走 Tavily（国内可达）；多个 key 用逗号隔开，额度用完自动切换下一个；留空则用 DuckDuckGo。'
        })}
      >
        <EnvField
          envKey="TAVILY_API_KEY"
          control="password"
          label={t('settings.integrations.websearch.tavily.label', {
            defaultValue: 'Tavily API Key'
          })}
          helper={t('settings.integrations.websearch.tavily.helper', {
            defaultValue:
              '在 tavily.com 申请（tvly- 前缀）。多个 key 逗号分隔，额度用尽自动轮换下一个；仅本机 .env 存储，不回传界面。修改后需重启后端生效。'
          })}
        />
      </Section>

      {/* 项目周报同步 Section 已随 v1.3.0 dogfood 收编进 Agents 页的
          ProjectProgressConfigDrawer（活字段 SYNC_ENABLED / DATABASE_ID / FILTER_BU
          搬进抽屉；AUTO_SYNC_ENABLED / SUBJECT_PATTERN / SENDER 是 v31 行迁移后的死
          配置 —— 活版本 = 抽屉的启用开关 / 发件人 / 标题正则，直接移除）。 */}
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
