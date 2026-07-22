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
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useKosGate } from '@shared/hooks/useLlmModels'
import { qk } from '@shared/lib/queryKeys'
import { Button } from '@shared/components/ui/button'
import { toastError } from '@shared/state/toast'
import type { KosDoctorCheck } from '@shared/api/types'
import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'
import { AdvancedDisclosure } from '../parts/AdvancedDisclosure'

function errLabel(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function IntegrationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  // issue #54 — KOS 连接检查（doctor）+ 激活 gate 被动显因。此前凭据错/服务挂/隧道断
  // 全部静默（gate 不满足时对话不注入 KOS 工具，UI 无任何反馈），只能翻后端日志。
  const kosGate = useKosGate()
  const [kosChecks, setKosChecks] = React.useState<KosDoctorCheck[] | null>(null)
  const [kosDoctorRunning, setKosDoctorRunning] = React.useState(false)

  async function handleKosDoctor(): Promise<void> {
    setKosDoctorRunning(true)
    try {
      const checks = await api.chat.kosDoctor()
      setKosChecks(checks)
    } catch (err) {
      setKosChecks(null)
      toastError(
        t('settings.integrations.kos.doctor.fail', { defaultValue: 'KOS 连接检查失败' }),
        errLabel(err)
      )
    } finally {
      setKosDoctorRunning(false)
      // gate 显因与 doctor 同源 /chat/config —— 检查完顺带刷新被动提示（共享 queryKey）。
      void qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
    }
  }

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
        {/* issue #54 — gate 显因：开关"开" ≠ 实际激活（gate = 开关 AND 凭据齐全），
            不满足时对话静默不注入 KOS 工具。这里把脱节显式化，不再静默。 */}
        {kosGate.consumerEnabled && !kosGate.configured ? (
          <div className="flex items-start gap-2 px-4 py-3 text-meta">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-warn" aria-hidden="true" />
            <span className="text-warn">
              {t('settings.integrations.kos.gateWarning', {
                defaultValue:
                  'KOS 已启用但凭据未配齐 —— 对话不会注入 KOS 工具。补全上方凭据后可用「连接检查」验证。'
              })}
            </span>
          </div>
        ) : null}
        <Row
          label={t('settings.integrations.kos.doctor.label', { defaultValue: '连接检查' })}
          helper={t('settings.integrations.kos.doctor.helper', {
            defaultValue: '分步验证：凭据配置 → 服务可达 → OAuth token → 真实调用。'
          })}
        >
          <Button
            onClick={handleKosDoctor}
            disabled={kosDoctorRunning}
            variant="secondary"
            size="sm"
          >
            {kosDoctorRunning ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t('settings.integrations.kos.doctor.running', { defaultValue: '检查中' })}
              </>
            ) : (
              t('settings.integrations.kos.doctor.button', { defaultValue: '检查' })
            )}
          </Button>
        </Row>
        {kosChecks && kosChecks.length > 0 && (
          <div className="px-4 py-3 space-y-1.5">
            {kosChecks.map((c, i) => {
              const ok = c.status === 'ok'
              return (
                <div key={`${c.check}-${i}`} className="flex items-start gap-2 text-meta">
                  {ok ? (
                    <Check className="size-3.5 shrink-0 mt-0.5 text-ok" />
                  ) : (
                    <X className="size-3.5 shrink-0 mt-0.5 text-fail" />
                  )}
                  <div className="min-w-0">
                    <span className="text-ink-fg-1">{c.check}</span>
                    {c.detail ? (
                      <span className="text-ink-fg-2 font-mono ml-1.5 break-all">{c.detail}</span>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
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

      {/* Web 搜索（Tavily key）配置已随 task 07-07 R4 迁到 AI tab → 系统能力区「联网」卡
          （SystemCapabilitiesSection 的 WebCapabilityRow：联网开关 ON 时联动显示）。此处不再重复。 */}

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
