// SystemCapabilitiesSection — R4 (task 07-05) 内置系统能力只读区 · task 07-22 能力可见性全景
//
// 原则（07-22 owner 拍板）：每个 chat 里可被 agent 调用的能力族都要在此可见 ——「可调用即可见」。
// 能开关的用真开关（联网），不能在此开关的用锁定/禁用态行；**flag off 也显示（禁用态）而非隐身**。
// 🔴 纯展示：除「联网」卡（A'，写 MAILAGENT_OPENNESS_WEB_TOOLS + Tavily key）外零后端写调用；
// 不动 skill_gating 的 GATEWAY_SKILL_TOOLS/CORE_UNGATED；不往 skill registry 塞假 skill。
//
// 本区呈现的能力族（权威盘点见 .trellis/tasks/07-22-capability-visibility-panorama/progress.md §1）：
//   恒可用核心（锁定 · 无 flag）：
//     · 核心邮件操作 email_flag/archive/pin/draft_reply/draft_compose/draft_update/resync
//       + prepare_send（写操作经审批卡保护；prd 07-27 加 draft_compose/draft_update 后共 8 件，
//       见 CORE_EMAIL_TOOL_COUNT 及其漂移守护 tests/shared/systemCapabilitiesCoreEmailToolCount.test.ts）
//     · KOS 知识大脑 六件只读 kos_query/search/get_page/find_experts/list_pages/get_backlinks
//       （core read，恒注册；效果取决于是否配好 Gbrain。issue #57 前只有 kos_query 一件）
//   env-flag 锁定族（on=锁定态 / off=禁用态，运行时不可在此切换）：
//     · 会话检索 chat_session_*                 (MAILAGENT_OPENNESS_SESSION_TOOLS, /chat/config)
//     · Agent 自配置 agent_profile_*/agent_memory_update (MAILAGENT_OPENNESS_CONFIG_TOOLS, /chat/config)
//     · 自我配置元工具 update_system_md/discover_skills/set_skill_enabled (MAILAGENT_SKILL_SELF_MOUNT, .env 意图)
//     · 日历工具（聊天）calendar_*             (MAILAGENT_CALENDAR_AGENT_TOOLS, .env 意图)
//   A'. 联网 web_fetch/web_search → 真开关（可写例外），恒渲染，见 WebCapabilityRow。
//   B. 已有管理面三族 → 交叉引用行（恒渲染，off 置灰）：
//     · 命令执行/文件读写 → ExecPolicySection  (MAILAGENT_OPENNESS_EXEC_TOOLS)
//     · 技能包管理        → SkillPacksSection  (MAILAGENT_OPENNESS_SKILL_INSTALL)
//     · 自定义 Agent      → /agents 路由        (MAILAGENT_CUSTOM_AGENTS_ENABLED)

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Bot,
  Calendar,
  Database,
  Globe,
  Lock,
  Mail,
  MessageSquare,
  Package,
  Terminal,
  UserCog,
  Wrench
} from 'lucide-react'

import { useOpennessFlags, useCustomAgentsEnabled } from '@shared/components/agents/hooks'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { fetchSkillInstallEnabled, useEnvFlagIntent } from './shared'
import { SYSTEM_CAP_SCROLL_TARGETS } from './scrollTargets'

// 同页交叉引用滚动锚点（CustomAiSection 里 SkillPacksSection / ExecPolicySection 各裹一个 id div）。
// 值本身自 08-01 PR4 起下沉到零依赖叶子 ./scrollTargets（锚点导航是第二个消费方，不该为两个
// 字符串把本文件的依赖树拉进一个常量模块）；此处保留同名 re-export，既有 import 站点不动。
export { SYSTEM_CAP_SCROLL_TARGETS } from './scrollTargets'

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 锁定态卡右侧控件：不可关的 pill + 视觉 on / disabled 的 Switch（无任何 onCheckedChange —
 *  它是「有意锁定」而非「坏掉的开关」，disabled 阻断交互、pill + tooltip 说明由环境变量控制）。 */
function LockedCapabilityControl(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-2"
        title={t('settings.systemCapabilities.lockedTip')}
      >
        <Lock className="size-2.5" />
        {t('settings.systemCapabilities.lockedBadge')}
      </span>
      <Switch checked disabled aria-label={t('settings.systemCapabilities.lockedBadge')} />
    </div>
  )
}

/** 禁用态卡右侧控件（task 07-22）：灰 pill「未启用」+ 视觉 off / disabled 的 Switch。用于 env-flag
 *  关闭的能力族 —— 显示禁用态而非隐身。同样无 onCheckedChange（此处不可切换，需改 .env + 重启）。 */
function DisabledCapabilityControl(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-3"
        title={t('settings.systemCapabilities.disabledTip')}
      >
        {t('settings.systemCapabilities.disabledBadge')}
      </span>
      <Switch
        checked={false}
        disabled
        aria-label={t('settings.systemCapabilities.disabledBadge')}
      />
    </div>
  )
}

/** 锁定/禁用态二选一（enabled → 锁定 on；否则 → 禁用 off）。 */
function CapabilityStateControl({ enabled }: { enabled: boolean }): React.ReactElement {
  return enabled ? <LockedCapabilityControl /> : <DisabledCapabilityControl />
}

/** 单行 helper：一句说明 + 控制来源行（env flag code 样式 / 恒可用说明）+ 工具数 pill。 */
function CapabilityHelper({
  desc,
  source,
  toolCount
}: {
  desc: React.ReactNode
  /** 控制来源：flag → 「由环境变量控制 <code>FLAG</code>」；always → 恒可用说明文案。 */
  source: { kind: 'flag'; flagName: string } | { kind: 'always'; note: React.ReactNode }
  toolCount: number
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className="flex flex-col gap-0.5">
      <span>{desc}</span>
      <span className="text-ink-fg-3">
        {source.kind === 'flag' ? (
          <>
            {t('settings.systemCapabilities.controlledBy')}{' '}
            <code className="rounded bg-ink-4 border border-ink-border px-1 py-px text-micro font-mono text-ink-fg-2">
              {source.flagName}
            </code>
          </>
        ) : (
          source.note
        )}
      </span>
      <span className="mt-0.5">
        <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
          {t('settings.skills.toolCount', { n: toolCount })}
        </span>
      </span>
    </span>
  )
}

/** 「联网」能力卡（task 07-07 R4）—— A' 可写例外。真开关写 MAILAGENT_OPENNESS_WEB_TOOLS
 *  （restart-required）+ 恒渲染 + ON 时联动 Tavily key。
 *
 *  开关 checked 反映 **.env 意图值**（读 useEnvStore snapshot，非 /chat/config 的 gateway
 *  运行态）——flag 是 gateway 启动 envBool 读一次的 restart-required 值，翻它后 .env 立即变但
 *  gateway 未变；开关跟随 .env 意图 + markRestartRequired 拉起全局重启横幅即可。envBool 语义镜像
 *  （ai_gateway_lifecycle.ts:86）：未设（'') → 默认 true（E3 cutover）；否则 lowercased ∈ {1,true}。 */
export function WebCapabilityRow(): React.ReactElement {
  const { t } = useTranslation()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const envState = useEnvStore((s) => s.state)
  const [submitting, setSubmitting] = React.useState(false)

  // 远程 web（HttpApi）只读：env:set 是 notImplemented → 开关禁用（镜像 EnvField 的 isWeb 探针）。
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  const ready = envState.status === 'ready'
  const raw = ready ? (envState.snapshot.values['MAILAGENT_OPENNESS_WEB_TOOLS'] ?? '') : ''
  // envBool 镜像：未设 → 默认 ON；显式值 lowercased ∈ {1,true} → ON。未 ready → 乐观按默认 ON
  // 展示但禁用交互（避免 env store 未加载时误写）。
  const checked = ready ? raw === '' || ['1', 'true'].includes(raw.trim().toLowerCase()) : true

  async function onToggle(next: boolean): Promise<void> {
    setSubmitting(true)
    try {
      const result = await applyEnvPatch({ MAILAGENT_OPENNESS_WEB_TOOLS: next ? 'true' : 'false' })
      if (result.ok) {
        // restart-required：gateway 启动读一次 → 拉起全局重启横幅（同 EnvField.persist）。
        if (result.changedKeys.length > 0) markRestartRequired(result.changedKeys)
        toastSuccess(t('settings.systemCapabilities.web.title'))
      } else {
        toastError(
          t('settings.systemCapabilities.web.title'),
          `${result.error.code}: ${result.error.message}`
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Row
        label={
          <span className="flex items-center gap-2">
            <Globe className="size-3.5 shrink-0 text-ink-fg-2" />
            {t('settings.systemCapabilities.web.title')}
          </span>
        }
        helper={
          <span className="flex flex-col gap-0.5">
            <span>{t('settings.systemCapabilities.web.desc')}</span>
            <span className="text-ink-fg-3">
              {t('settings.systemCapabilities.web.restartHint')}
            </span>
            <span className="mt-0.5">
              <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
                {t('settings.skills.toolCount', { n: 2 })}
              </span>
            </span>
          </span>
        }
      >
        <Switch
          checked={checked}
          disabled={!ready || isWeb || submitting}
          onCheckedChange={onToggle}
          aria-label={t('settings.systemCapabilities.web.switchLabel')}
        />
      </Row>
      {checked && (
        <EnvField
          envKey="TAVILY_API_KEY"
          control="password"
          label={t('settings.systemCapabilities.web.tavily.label')}
          helper={t('settings.systemCapabilities.web.tavily.helper')}
          placeholder={t('settings.systemCapabilities.web.tavily.placeholder')}
          hotReload
        />
      )}
    </>
  )
}

/** 「核心邮件操作」toolCount 的真源手抄值 —— 真源 = `src/ai-gateway/tools/skill_gating.ts` 的
 *  `CORE_UNGATED_GATEWAY_TOOLS` 里所有 `email_` 前缀条目（该 Set 内该前缀恰好等于此写族 8 件，
 *  读工具走 `GATEWAY_SKILL_TOOLS.email` 家族、不进 CORE_UNGATED，故前缀过滤不会误收）。不直接
 *  import skill_gating.ts（main-process AI Gateway 代码，renderer 无该 alias，不引入跨进程耦合）；
 *  漂移由 `tests/shared/systemCapabilitiesCoreEmailToolCount.test.ts` 守护——两边其一漏改即变红。 */
export const CORE_EMAIL_TOOL_COUNT = 8

interface CapabilityRow {
  key: string
  icon: React.ReactNode
  title: string
  desc: string
  source: { kind: 'flag'; flagName: string } | { kind: 'always'; note: React.ReactNode }
  toolCount: number
  /** 锁定/禁用态；always 源恒 true。 */
  enabled: boolean
}

export function SystemCapabilitiesSection(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const flags = useOpennessFlags(true)
  const customAgentsEnabled = useCustomAgentsEnabled()

  // /chat/config 未暴露的 main-env-only flag → 读 .env 意图值（三者默认 on）。
  const selfMountEnabled = useEnvFlagIntent('MAILAGENT_SKILL_SELF_MOUNT', true)
  const calendarEnabled = useEnvFlagIntent('MAILAGENT_CALENDAR_AGENT_TOOLS', true)

  // 技能包管理面可见性（与 SkillPacksSection 共享同一 query cache，去重）。
  const { data: skillInstallEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('skillInstallEnabled'),
    queryFn: fetchSkillInstallEnabled,
    staleTime: 30_000,
    retry: false
  })

  // 恒渲染的能力族行（锁定/禁用态）。恒可用核心（写/发信、KOS）→ always 源锁定；env-flag 族 →
  // enabled 来自 flag 值。/chat/config 的 flag 用 `!== false`：true / undefined（旧后端或不可达）
  // → 视为 on（env 默认 on，WebCapabilityRow 乐观先例），仅显式 false → 禁用态。
  const capabilityRows: CapabilityRow[] = [
    {
      key: 'coreEmail',
      icon: <Mail className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.coreEmail.title'),
      desc: t('settings.systemCapabilities.coreEmail.desc'),
      source: { kind: 'always', note: t('settings.systemCapabilities.coreEmail.control') },
      toolCount: CORE_EMAIL_TOOL_COUNT,
      enabled: true
    },
    {
      key: 'kos',
      icon: <Database className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.kos.title'),
      desc: t('settings.systemCapabilities.kos.desc'),
      source: { kind: 'always', note: t('settings.systemCapabilities.kos.control') },
      // issue #57 起 6 件（query/search/get_page/find_experts/list_pages/get_backlinks）。
      // 与 gateway 注册面同步的权威清单见 tools/kos.ts + agents/toolGroups.ts 的 knowledge 组。
      toolCount: 6,
      enabled: true
    },
    {
      key: 'session',
      icon: <MessageSquare className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.session.title'),
      desc: t('settings.systemCapabilities.session.desc'),
      source: { kind: 'flag', flagName: 'MAILAGENT_OPENNESS_SESSION_TOOLS' },
      toolCount: 3,
      enabled: flags.sessionToolsEnabled !== false
    },
    {
      key: 'config',
      icon: <UserCog className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.config.title'),
      desc: t('settings.systemCapabilities.config.desc'),
      source: { kind: 'flag', flagName: 'MAILAGENT_OPENNESS_CONFIG_TOOLS' },
      toolCount: 4,
      enabled: flags.configToolsEnabled !== false
    },
    {
      key: 'selfMount',
      icon: <Wrench className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.selfMount.title'),
      desc: t('settings.systemCapabilities.selfMount.desc'),
      source: { kind: 'flag', flagName: 'MAILAGENT_SKILL_SELF_MOUNT' },
      toolCount: 3,
      enabled: selfMountEnabled
    },
    {
      key: 'calendar',
      icon: <Calendar className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.calendar.title'),
      desc: t('settings.systemCapabilities.calendar.desc'),
      source: { kind: 'flag', flagName: 'MAILAGENT_CALENDAR_AGENT_TOOLS' },
      toolCount: 5,
      enabled: calendarEnabled
    }
  ]

  // B. 已有管理面三族：交叉引用行（恒渲染，off 置灰跳转 + 未启用 pill）。
  const crossRefs: Array<{
    key: string
    icon: React.ReactNode
    title: string
    desc: string
    action: string
    enabled: boolean
    onGo: () => void
  }> = [
    {
      key: 'exec',
      icon: <Terminal className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.exec.title'),
      desc: t('settings.systemCapabilities.crossRef.exec.desc'),
      action: t('settings.systemCapabilities.crossRef.exec.action'),
      enabled: flags.execToolsEnabled !== false,
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.exec)
    },
    {
      key: 'skillPacks',
      icon: <Package className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.skillPacks.title'),
      desc: t('settings.systemCapabilities.crossRef.skillPacks.desc'),
      action: t('settings.systemCapabilities.crossRef.skillPacks.action'),
      enabled: skillInstallEnabled !== false,
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.skillPacks)
    },
    {
      key: 'customAgents',
      icon: <Bot className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.customAgents.title'),
      desc: t('settings.systemCapabilities.crossRef.customAgents.desc'),
      action: t('settings.systemCapabilities.crossRef.customAgents.action'),
      enabled: customAgentsEnabled,
      onGo: () => void navigate({ to: '/agents', search: { tab: 'agents' } })
    }
  ]

  return (
    <Section
      title={t('settings.systemCapabilities.title')}
      helper={t('settings.systemCapabilities.desc')}
    >
      {capabilityRows.map((cap) => (
        <Row
          key={cap.key}
          label={
            <span className="flex items-center gap-2">
              {cap.icon}
              {cap.title}
            </span>
          }
          helper={
            <CapabilityHelper desc={cap.desc} source={cap.source} toolCount={cap.toolCount} />
          }
        >
          <CapabilityStateControl enabled={cap.enabled} />
        </Row>
      ))}

      {/* A' 联网可写例外：恒渲染真开关（写 MAILAGENT_OPENNESS_WEB_TOOLS）+ ON 时联动 Tavily key。 */}
      <WebCapabilityRow />

      {crossRefs.map((ref) => (
        <Row
          key={ref.key}
          label={
            <span className="flex items-center gap-2">
              {ref.icon}
              {ref.title}
            </span>
          }
          helper={<span>{ref.desc}</span>}
          trailing={
            ref.enabled ? undefined : (
              <span
                className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-3"
                title={t('settings.systemCapabilities.disabledTip')}
              >
                {t('settings.systemCapabilities.disabledBadge')}
              </span>
            )
          }
        >
          <Button size="sm" variant="ghost" onClick={ref.onGo} disabled={!ref.enabled}>
            {ref.action}
            <ArrowUpRight className="ml-1 size-3.5" />
          </Button>
        </Row>
      ))}
    </Section>
  )
}
