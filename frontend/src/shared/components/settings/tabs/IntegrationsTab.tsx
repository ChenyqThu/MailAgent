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
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useKosGate } from '@shared/hooks/useLlmModels'
import { qk } from '@shared/lib/queryKeys'
import { Button } from '@shared/components/ui/button'
import { toastError } from '@shared/state/toast'
import { useEnvStore } from '@shared/state/env'
import { envFlagOn } from '@shared/components/agents/shared'
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

/** Lane 2 #2 — 「仅推已标注」×「AI 分类关」的静默死锁联动警告 (issue #49 / 审计 §4)。
 *
 *  KOS_REQUIRE_LABELED=true 时只放行 AI 明确判定过优先级的邮件, 而「判定过」的唯一
 *  来源是 AI 邮件预处理 (LLM_AGENT_ENABLED)。两者一开一关 = 入库开着、凭据齐、看板
 *  显示 active, 但一封都推不进去、零报错。静态 helper 用户不会读 —— 这里按两个 env
 *  值条件渲染 (读 useEnvStore snapshot, 同 AgentsTab 预处理卡的 envFlagOn pattern),
 *  并给跳转 Agents 页的链接 (AI 分类的开关在那边)。 */
function KosRequireLabeledDeadlockWarning(): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const requireLabeledOn = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['KOS_REQUIRE_LABELED'] ?? '')
      : false
  )
  const llmAgentEnabled = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['LLM_AGENT_ENABLED'] ?? '')
      : false
  )
  if (!requireLabeledOn || llmAgentEnabled) return null
  return (
    <div className="flex items-start gap-2 px-4 py-3 text-meta">
      <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-warn" aria-hidden="true" />
      <span className="text-warn">
        {t('settings.integrations.kos.requireLabeled.deadlockWarning', {
          defaultValue:
            '「AI 邮件预处理」当前是关闭的——没有任何邮件会被标注优先级，这个开关会让入库完全停止（不会报错，只是静默推不进去）。请先到 Agents 页开启 AI 邮件预处理，或关闭本开关。'
        })}{' '}
        <button
          type="button"
          onClick={() => void navigate({ to: '/agents', search: { tab: 'agents' } })}
          className="underline underline-offset-2 hover:text-ink-fg cursor-pointer"
        >
          {t('settings.integrations.kos.requireLabeled.goToAgents', {
            defaultValue: '前往 Agents 页开启 →'
          })}
        </button>
      </span>
    </div>
  )
}

export function IntegrationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  // issue #54 — KOS 连接检查（doctor）+ 激活 gate 被动显因。此前凭据错/服务挂/隧道断
  // 全部静默（gate 不满足时对话不注入 KOS 使用指南、工具一调即 E_KOS_NOT_CONFIGURED，
  // UI 无任何反馈），只能翻后端日志。
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
                ' 部署服务并申请 OAuth 凭据，填入下方。未对接（凭据缺失）时对话 AI 查不到知识大脑，调用会返回未配置错误。'
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
              '开启后，对话 AI 可调用 kos_query / kos_search / kos_get_page / kos_find_experts 等知识大脑读工具（需下方凭据齐全）。'
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
            不满足时对话不注入 KOS 使用指南、且工具一调即失败。这里把脱节显式化，不再静默。
            （issue #57 更正：工具本身恒注册，gate 的是指南块 —— 见 chat.py chat_config。） */}
        {kosGate.consumerEnabled && !kosGate.configured ? (
          <div className="flex items-start gap-2 px-4 py-3 text-meta">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-warn" aria-hidden="true" />
            <span className="text-warn">
              {t('settings.integrations.kos.gateWarning', {
                defaultValue:
                  'KOS 已启用但凭据未配齐 —— 对话 AI 不会被告知有知识大脑可查，调用也会直接失败。补全上方凭据后可用「连接检查」验证。'
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
          {/* Lane 2 #2 (issue #49) — 「推什么进知识库」的两半, 紧跟入库开关、在凭据之前:
              开入库 → 推什么 → 用什么凭据推。floor 管重要度门槛; require_labeled 管
              「AI 从未判定过的邮件算不算数」。只放一个, 用户看到 floor=normal 会以为已在
              过滤 —— 实际约 89% 是未标注邮件走了默认放行分支。🔴 两个默认值都不动。 */}
          <EnvField
            envKey="KOS_INGEST_PRIORITY_FLOOR"
            control="select"
            label={t('settings.integrations.kos.priorityFloor.label', {
              defaultValue: '入库重要度门槛'
            })}
            helper={t('settings.integrations.kos.priorityFloor.helper', {
              defaultValue:
                '只把 AI 判定重要度不低于这一档的邮件推进知识库，挡住广告、系统通知等低价值邮件。注意：AI 从未分类过的邮件会被当作「普通」看待——要把它们也挡掉，请开启下方「仅推送已标注的邮件」。'
            })}
            options={[
              {
                value: 'critical',
                label: t('settings.integrations.kos.priorityFloor.critical', {
                  defaultValue: 'Critical（仅最高优先级）'
                })
              },
              {
                value: 'urgent',
                label: t('settings.integrations.kos.priorityFloor.urgent', {
                  defaultValue: 'Urgent 及以上'
                })
              },
              {
                value: 'important',
                label: t('settings.integrations.kos.priorityFloor.important', {
                  defaultValue: 'Important 及以上'
                })
              },
              {
                value: 'normal',
                label: t('settings.integrations.kos.priorityFloor.normal', {
                  defaultValue: 'Normal 及以上（默认）'
                })
              },
              {
                value: 'low',
                label: t('settings.integrations.kos.priorityFloor.low', {
                  defaultValue: 'Low 及以上（全部推送）'
                })
              }
            ]}
            placeholder={t('settings.integrations.kos.priorityFloor.placeholder', {
              defaultValue: 'Normal 及以上（默认）'
            })}
            placeholderOnEmpty
          />
          <EnvField
            envKey="KOS_REQUIRE_LABELED"
            control="toggle"
            label={t('settings.integrations.kos.requireLabeled.label', {
              defaultValue: '仅推送已标注的邮件'
            })}
            helper={t('settings.integrations.kos.requireLabeled.helper', {
              defaultValue:
                '关闭（默认）时，AI 从未分类过的邮件——包括你启用 AI 分类之前的全部历史邮件——都会被当作「普通」放行入库。开启后只推 AI 明确判定过优先级的邮件；未标注的会被跳过（不是丢弃，日后补跑分类会重新入库）。前置条件：依赖「AI 邮件预处理」在跑，否则不会有任何邮件被标注。'
            })}
          />
          <KosRequireLabeledDeadlockWarning />
          {/* issue #64 — producer 凭据的 UI 入口。与上方 OAuth 那两个是**两套**凭据:
              consumer (chat 读 KOS) 走 KOS_OAUTH_CLIENT_*, producer (推送邮件入库) 走
              这两个 MAILAGENT_BULK_*。它们是 v1.19.1 新引入的必配项, 而 .env.example
              只对新装用户有效 —— 老用户升上来必然缺、入库看板必然整区消失, 且此前
              没有任何 UI 入口可补。摆在入库开关正下方: 它们只在开关打开时才有意义。
              凭据仍不进 config.py (裸 os.getenv, 见 env_only_reads_allowlist.txt D 类),
              这里只是可见可填。 */}
          <EnvField
            envKey="MAILAGENT_BULK_CLIENT_ID"
            control="text"
            label={t('settings.integrations.kos.bulkClientId.label', {
              defaultValue: '入库 Client ID'
            })}
            helper={t('settings.integrations.kos.bulkClientId.helper', {
              defaultValue:
                '推送入库用的客户端 ID（gbrain_cl_ 前缀）。与上方对话读取用的 OAuth Client ID 是两套凭据，缺它则邮件推不进知识库。'
            })}
            placeholder="gbrain_cl_..."
          />
          <EnvField
            envKey="MAILAGENT_BULK_CLIENT_SECRET"
            control="password"
            label={t('settings.integrations.kos.bulkClientSecret.label', {
              defaultValue: '入库 Client Secret'
            })}
            helper={t('settings.integrations.kos.bulkClientSecret.helper', {
              defaultValue:
                '推送入库用的客户端密钥（gbrain_cs_ 前缀），仅本机 .env 存储，不回传界面。'
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
      {/* 原「Office 附件转换」区。OFFICE_CONVERT_ENABLED 随 2026-08 Notion 派生退役
          删除（Notion 侧沙盒电脑可直接读 office 文件），本区收窄为附件的文字识别。 */}
      <Section
        title={t('settings.integrations.attachments.title')}
        helper={t('settings.integrations.attachments.helper')}
      >
        {/* Lane 2 #9 — 附件 OCR。默认 ON (config.py 默认 true) → defaultOn 让未设时
            如实显示为开。「本地识别、不联网」对有隐私顾虑的用户是加分项, 写进 helper。 */}
        <EnvField
          envKey="MAILAGENT_ATTACHMENT_OCR_ENABLED"
          control="toggle"
          defaultOn
          label={t('settings.integrations.ocr.label', {
            defaultValue: '图片与扫描件文字识别（OCR）'
          })}
          helper={t('settings.integrations.ocr.helper', {
            defaultValue:
              '识别图片附件和扫描版 PDF 里的中英文字，让它们能被全文搜索到。使用 macOS 内置的本地识别（Vision），内容不会离开这台电脑、不联网。关闭后图片和扫描件将无法被搜索。默认开启。'
          })}
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
