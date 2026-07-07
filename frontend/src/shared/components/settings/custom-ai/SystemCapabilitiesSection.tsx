// SystemCapabilitiesSection — R4 (task 07-05) 内置系统能力只读区
//
// 技能面板此前只列 skill 对象（email/search/report + 已装 pack），看不到 S1/S2/S5 的
// 开放性能力族。这些能力由 main-env-only flag 驱动，此区把它们呈现为三类：
//   A. 只读锁定族（无独立管理面 + flag 运行时不可切）→ 只读能力卡：锁定态 pill +
//      「视觉 on / disabled」Switch，绝无 onCheckedChange。flag === true 才渲染：
//        · 会话检索 chat_session_*                 (sessionToolsEnabled)
//        · Agent 自配置 agent_profile_*/agent_memory_update (configToolsEnabled)
//   A'. 联网（web_fetch + web_search）→ **可写例外**（task 07-07 R4）：真开关写
//      MAILAGENT_OPENNESS_WEB_TOOLS（restart-required，gateway 启动读一次）+ 恒渲染
//      （OFF 也在，好再开）；开关 ON 时卡下联动显示 Tavily key（EnvField，写 .env 受管密钥）。
//      开关 checked 反映 .env 意图值（读 useEnvStore，非 gateway 运行态 —— restart 前 gateway
//      未变但 .env 已变）。见 WebCapabilityRow。
//   B. 已有管理面三族 → 交叉引用行（跳到对应管理面，不造新卡）：
//        · 命令执行/文件读写 → 同页 ExecPolicySection  (execToolsEnabled)
//        · 技能包管理        → 同页 SkillPacksSection  (skillInstallEnabled)
//        · 自定义 Agent      → /agents 路由            (customAgentsEnabled)
//
// 红线：除「联网」卡（A'，写 MAILAGENT_OPENNESS_WEB_TOOLS + Tavily key）外纯只读展示、零后端
// 写调用；不动 skill_gating 的 GATEWAY_SKILL_TOOLS/CORE_UNGATED；不往 resolved_skills()/
// build_manifest()/skill registry 塞假 skill 行。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Bot,
  Globe,
  Lock,
  MessageSquare,
  Package,
  Terminal,
  UserCog
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
import { fetchSkillInstallEnabled } from './shared'

// 同页交叉引用滚动锚点（CustomAiSection 里 SkillPacksSection / ExecPolicySection 各裹一个 id div）。
export const SYSTEM_CAP_SCROLL_TARGETS = {
  exec: 'settings-exec-policy',
  skillPacks: 'settings-skill-packs'
} as const

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

export function SystemCapabilitiesSection(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const flags = useOpennessFlags(true)
  const customAgentsEnabled = useCustomAgentsEnabled()

  // 技能包管理面可见性（与 SkillPacksSection 共享同一 query cache，去重）。
  const { data: skillInstallEnabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'skillInstallEnabled'],
    queryFn: fetchSkillInstallEnabled,
    staleTime: 30_000,
    retry: false
  })

  // A. 只读锁定族（session/config）：flag === true 才渲染锁定卡。联网（web）不在此列 —— 它是
  // A' 可写例外，由 WebCapabilityRow 恒渲染（见下）。
  const capabilityCards: Array<{
    key: string
    icon: React.ReactNode
    title: string
    desc: string
    toolCount: number
  }> = []
  if (flags.sessionToolsEnabled === true) {
    capabilityCards.push({
      key: 'session',
      icon: <MessageSquare className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.session.title'),
      desc: t('settings.systemCapabilities.session.desc'),
      toolCount: 3
    })
  }
  if (flags.configToolsEnabled === true) {
    capabilityCards.push({
      key: 'config',
      icon: <UserCog className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.config.title'),
      desc: t('settings.systemCapabilities.config.desc'),
      toolCount: 4
    })
  }

  // B. 已有管理面三族：交叉引用行（点击跳对应管理面）。
  const crossRefs: Array<{
    key: string
    icon: React.ReactNode
    title: string
    desc: string
    action: string
    onGo: () => void
  }> = []
  if (flags.execToolsEnabled === true) {
    crossRefs.push({
      key: 'exec',
      icon: <Terminal className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.exec.title'),
      desc: t('settings.systemCapabilities.crossRef.exec.desc'),
      action: t('settings.systemCapabilities.crossRef.exec.action'),
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.exec)
    })
  }
  if (skillInstallEnabled === true) {
    crossRefs.push({
      key: 'skillPacks',
      icon: <Package className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.skillPacks.title'),
      desc: t('settings.systemCapabilities.crossRef.skillPacks.desc'),
      action: t('settings.systemCapabilities.crossRef.skillPacks.action'),
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.skillPacks)
    })
  }
  if (customAgentsEnabled) {
    crossRefs.push({
      key: 'customAgents',
      icon: <Bot className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.customAgents.title'),
      desc: t('settings.systemCapabilities.crossRef.customAgents.desc'),
      action: t('settings.systemCapabilities.crossRef.customAgents.action'),
      onGo: () => void navigate({ to: '/agents', search: { tab: 'agents' } })
    })
  }

  // 联网卡（A'）恒渲染 → 本区永远至少有一行，故不再 return null（web 卡 OFF 也要在，好再开）。

  // 只读锁定族（session/config）未全开 → 尾部一行提示「其余系统能力由环境变量控制」。联网已是
  // 真开关，不计入「由环境变量控制」的隐藏族。
  const showMoreNote = flags.sessionToolsEnabled !== true || flags.configToolsEnabled !== true

  return (
    <Section
      title={t('settings.systemCapabilities.title')}
      helper={t('settings.systemCapabilities.desc')}
    >
      {capabilityCards.map((cap) => (
        <Row
          key={cap.key}
          label={
            <span className="flex items-center gap-2">
              {cap.icon}
              {cap.title}
            </span>
          }
          helper={
            <span className="flex flex-col gap-0.5">
              <span>{cap.desc}</span>
              <span className="mt-0.5">
                <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
                  {t('settings.skills.toolCount', { n: cap.toolCount })}
                </span>
              </span>
            </span>
          }
        >
          <LockedCapabilityControl />
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
        >
          <Button size="sm" variant="ghost" onClick={ref.onGo}>
            {ref.action}
            <ArrowUpRight className="ml-1 size-3.5" />
          </Button>
        </Row>
      ))}

      {showMoreNote && (
        <div className="px-4 py-2.5 text-aux text-ink-fg-3">
          {t('settings.systemCapabilities.moreNote')}
        </div>
      )}
    </Section>
  )
}
