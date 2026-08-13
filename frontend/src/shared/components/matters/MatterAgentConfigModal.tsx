import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Settings, Shield, Sparkles, X } from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import type {
  Matter,
  MatterAgentOverrides,
  MatterPatchInput,
  MatterRun
} from '@shared/api/types/matter'
import type { MatterRunAction } from '@shared/api/types/matter'
import { MATTER_RUN_ACTIONS } from '@shared/api/types/matter'
import { ModelSelectItems } from '@shared/components/agents/drawers/ModelSelectItems'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import { preview } from '@shared/components/agents/schedule/occurrences'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { DEFAULT_RULE } from '@shared/components/agents/schedule/types'
import { Checkbox } from '@shared/components/ui/checkbox'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { Switch } from '@shared/components/ui/switch'
import { useComposerModels } from '@shared/hooks/useComposerModels'
import { stripProviderPrefix } from '@shared/hooks/useLlmProviders'
import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { effortOptionsForModel } from '@shared/modelCatalog/effort'
import { toastSuccess } from '@shared/state/toast'

import { MatterGlobalAgentModal } from './MatterGlobalAgentModal'
import { MatterTriggerEditor } from './MatterTriggerEditor'
import {
  buildTriggerEnvelope,
  parseAgentOverrides,
  parseMatterSchedule,
  parseMatterScheduleValue,
  parseRunActions,
  parseTriggerEntries
} from './matterSchedule'
import { effectiveContract, useMatterGlobalAgentDoc } from './useMatterGlobalAgentDoc'

/**
 * 事项级「跟进规则」配置（设计 `matter-agent.jsx:362-492` 的 560px Modal）。
 *
 * 🔴 为什么从右栏搬进模态：跟进配置此前只活在 `MatterContextRail` 的绑定卡里，而右栏
 * **只在 ≥1400px 渲染** —— 窗口小一点，全应用就再没有任何入口能改跟进方式（0812 dogfood
 * owner 报「无法切换跟进的方式」的根因）。模态挂在详情头的 Agent pill 上，与窗口宽度无关。
 *
 * 设计画的两个 select 分别落地成：
 *   · **模型** —— 0813 dogfood 轮 3 反馈 #10 做了（owner：「仍然没有模型配置、effort 配置、
 *     fallback 配置……高级里面也没有模型覆盖配置」）。此前只能靠换绑 profile 间接换模型，
 *     而 profile 是「另一个 Agent 的人设 + 模型」，想只改模型就得凭空造一个 Agent。现在
 *     高级区里直接给三项覆盖：模型 / 思考强度 / 备用模型，落进 `schedule_json` envelope 的
 *     `agent` 块（零 DB 迁移，解析单源 `matterSchedule.ts` ↔ Python `triggers.py`）。
 *   · **授权级别** —— 仍然**不做**：授权是服务端按工具 class 强制的（读全放行、一个写工具
 *     都不给），per-matter 调不动，画出来就是假开关（同 `MatterGlobalAgentModal` 的判断）。
 *
 * 🔴 「思考强度」只在**选定了模型**之后可选，且该模型要有 reasoning 能力。不是保守，是
 * 结构性的：档位阶梯按模型家族给（`effortOptionsForModel`），而对没有 reasoning 能力的模型
 * 下发 effort 参数，openai / deepseek 协议会往 wire 上塞一个多余参数（16b 契约里写着这条）。
 * 「跟随默认」时我们根本不知道最终跑的是哪个模型，也就无从判断 —— 与其发一个可能让整个 run
 * 400 的参数，不如把「先选模型」这句话说出来。
 */

const BUILTIN_PROFILE_VALUE = '__builtin__'
/** 三项覆盖共用的「跟随」哨兵（= envelope 里不写该键）。 */
const FOLLOW_VALUE = '__follow__'
/** 备用模型专属：**显式不设兜底**（= envelope 里写 `fallback_models: []`），与「跟随」不是
 *  一回事 —— 前者会压过绑定 profile 的兜底链，后者跟着它走。 */
const NO_FALLBACK_VALUE = '__no_fallback__'

/** 库里的 envelope → 三个 select 的草稿值（哨兵化）。打开模态与「重新载入」共用一份。 */
function agentDraftFrom(scheduleJson: string | null | undefined): {
  model: string
  effort: string
  fallback: string
} {
  const saved = parseAgentOverrides(scheduleJson)
  return {
    model: saved.model ?? FOLLOW_VALUE,
    effort: saved.effort ?? FOLLOW_VALUE,
    fallback:
      saved.fallback_models === undefined
        ? FOLLOW_VALUE
        : saved.fallback_models.length === 0
          ? NO_FALLBACK_VALUE
          : saved.fallback_models[0]
  }
}

interface MatterAgentConfigModalProps {
  matter: Matter
  runs: readonly MatterRun[]
  profiles: readonly ReportAgentConfig[]
  /** 🔴 `expectedVersion` 由本模态给（打开时冻结的那一版），调用方不许改用「当前最新版本」
   *  —— 那会让乐观锁形同虚设，见下面 `baseVersion` 的注释。 */
  onPatch(input: MatterPatchInput, expectedVersion: number): Promise<unknown>
  onClose(): void
}

export function MatterAgentConfigModal({
  matter,
  runs,
  profiles,
  onPatch,
  onClose
}: MatterAgentConfigModalProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  /**
   * 🔴 草稿只在挂载时初始化，所以提交必须带**打开那一刻**的版本号。用父组件当前最新的
   * `matter.version` 会架空乐观锁：在 v3 打开模态、别处把排程改成 Y 并刷新到 v4，模态里
   * 仍是旧排程 X，保存却带 v4 ⇒ 服务端不判冲突，把 Y 静默覆盖回 X。
   */
  const [baseVersion, setBaseVersion] = useState(matter.version)
  const [agentOn, setAgentOn] = useState(
    matter.agent_enabled === true || matter.agent_enabled === 1
  )
  const [triggerDraft, setTriggerDraft] = useState(() => parseTriggerEntries(matter.schedule_json))
  const [actionsDraft, setActionsDraft] = useState(() => parseRunActions(matter.schedule_json))
  const [profileId, setProfileId] = useState(matter.agent_profile_id ?? BUILTIN_PROFILE_VALUE)
  const [agentDraft, setAgentDraft] = useState(() => agentDraftFrom(matter.schedule_json))
  const [instructions, setInstructions] = useState(matter.matter_instructions ?? '')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [contractOpen, setContractOpen] = useState(false)
  const [globalAgentOpen, setGlobalAgentOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 「下次运行」的基准时刻挂载时冻结：render 期间调 Date.now() 会被 react-hooks/purity 拒绝。
  const [now] = useState(() => Date.now())
  const scopeRef = useRef<HTMLDivElement>(null)
  // G-32 —— 遮罩 fadeIn + 卡片 popIn。只做进场：调用方 `{agentConfigOpen ? <Modal …/> : null}`
  // 硬挂载，且模态的草稿状态按挂载初始化，改成常驻会让上一次的编辑残留到下一次打开。
  const animScopeRef = useEnterAnimation<HTMLDivElement>({
    card: '[data-anim-card]',
    backdrop: true
  })

  // 关闭后焦点回到打开它的那颗 Agent pill（不然焦点掉回 body，键盘用户直接迷路）。
  // 🔴 必须声明在 `useFocusTrap` **之前**：同一个组件里 effect 按声明顺序跑，放在后面的话
  // 捕获到的已经是 trap 抢过去的那个关闭按钮，卸载后焦点等于掉回 body。
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  // 嵌套的全局 Agent 模态打开时把本层的 trap 让开 —— 它是本层的兄弟节点，两个 trap
  // 同时活着会互相抢焦点。配合下面的 `inert`，背景这层同时也不可交互。
  const { dialogRef, handleTab } = useFocusTrap({
    open: !globalAgentOpen,
    fallbackRef: scopeRef,
    // 高级区里的 Select 是 portal 到 body 的 Radix 组件：DOM 上不在容器内，
    // React 合成事件却会冒泡回来，不放行会把它的焦点拖回背景。
    ignoreOutsideTargets: true
  })

  // 「专属指令」是**追加**在全局任务契约之后的（Python `run_spec._task_contract()` 恒生效，
  // 事项级只是加一段【补充指引】），所以把当前生效的契约全文就地摆出来 —— 不写出来就只剩
  // 一句「留空使用默认」，用户看不到那个默认到底是什么（0812 dogfood owner 的正面诉求）。
  const contractDoc = useMatterGlobalAgentDoc()
  const contractText = effectiveContract(contractDoc.data)

  const profile = profiles.find((item) => item.id === matter.agent_profile_id)
  const dangling = Boolean(matter.agent_profile_id) && !profile

  // 模型清单与 chat 的模型选择器同源（`useComposerModels` = enabledModels × provider 元数据 ×
  // models.dev 目录）。这里要的不只是 ref 列表 —— 下面的 effort 档位得按选中模型的 protocol 与
  // reasoning 能力来给。
  const composerModels = useComposerModels()
  const modelRefs = composerModels.map((option) => option.ref)
  const modelOverride = agentDraft.model === FOLLOW_VALUE ? null : agentDraft.model
  const selectedModel = composerModels.find((option) => option.ref === modelOverride) ?? null
  // 「行权威、目录兜底」与 composer 同一叠加方向：provider 行标注过就用行的，没标注传 null
  // 交给目录三态（🔴 unknown ≠ false，不许把没标注的模型当不支持灰死）。
  const effortInfo = modelOverride
    ? effortOptionsForModel(
        // 存的是完整 providerRef；孤儿值（模型被从启用列表里去掉了）在 composerModels 里查不到，
        // 所以退回同一个 canonical 去前缀函数，而不是就地再写一遍切分。
        selectedModel?.modelId ?? stripProviderPrefix(modelOverride),
        selectedModel?.protocol ?? null,
        {
          reasoningCapable:
            selectedModel?.capabilities == null ? null : selectedModel.capabilities.reasoning === true
        }
      )
    : null
  const effortApplicable = effortInfo?.applicable === true
  // 不适用时**显示**成「跟随默认」而不是留着上一个模型的档位：保存时同样不写这个键，
  // 两边一致，界面上不会出现一个存不下去的选中值。
  const effortValue = effortApplicable ? agentDraft.effort : FOLLOW_VALUE

  // 设计 `matter-agent.jsx:365` 的 `ovCount`：折叠起来时也要看得见「这件事有几处覆盖了全局」。
  // 覆盖面 = 换执行 Agent / 追加专属指令 / 模型三项（0813 #10）。授权级别仍不做（服务端按
  // class 强制，per-matter 调不动，做成开关就是假 UI）。
  const overrideCount =
    (profileId === BUILTIN_PROFILE_VALUE ? 0 : 1) +
    (instructions.trim() ? 1 : 0) +
    (modelOverride ? 1 : 0) +
    (effortApplicable && agentDraft.effort !== FOLLOW_VALUE ? 1 : 0) +
    (agentDraft.fallback !== FOLLOW_VALUE ? 1 : 0)
  const latest = runs.find((run) => run.completed_at != null)

  /** 三个 select → envelope 的 `agent` 块。全是「跟随」⇒ 空对象 ⇒ builder 不写这个键。 */
  const agentOverrides = ((): MatterAgentOverrides => {
    const payload: MatterAgentOverrides = {}
    if (modelOverride) payload.model = modelOverride
    // 🔴 只在真能生效时才写：不适用的模型上存一个档位 = 保存了但不生效（还可能让 run 400）。
    if (effortApplicable && agentDraft.effort !== FOLLOW_VALUE) payload.effort = agentDraft.effort
    if (agentDraft.fallback === NO_FALLBACK_VALUE) payload.fallback_models = []
    else if (agentDraft.fallback !== FOLLOW_VALUE) payload.fallback_models = [agentDraft.fallback]
    return payload
  })()

  // 「计划」跟着草稿走（改一下就能看到句子变），「下次」只认已保存的排程 —— 还没保存的
  // 草稿算不出一个真会发生的时刻，写出来就是承诺一件没安排的事。
  const draftSchedule = parseMatterScheduleValue(buildTriggerEnvelope(triggerDraft, actionsDraft))
  const savedSchedule = parseMatterSchedule(matter.schedule_json)
  const planLabel = draftSchedule
    ? sentenceText(t, i18n.language || 'zh-CN', draftSchedule.rule)
    : t('matters.runs.manual')
  const next = savedSchedule
    ? preview(savedSchedule.rule, savedSchedule.timezone, savedSchedule.anchor, now, 1).find(
        (entry) => entry.kind === 'run'
      )
    : null

  const applyRecommended = (): void => {
    const seeded = newScheduleValue({
      ...DEFAULT_RULE,
      freq: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0
    })
    setTriggerDraft((entries) => [
      ...entries.filter((entry) => entry.kind !== 'schedule'),
      { ...seeded, id: 'mtr_recommended', kind: 'schedule' as const, enabled: true }
    ])
  }

  const toggleAction = (action: MatterRunAction): void => {
    setActionsDraft((current) =>
      current.includes(action)
        ? current.filter((value) => value !== action)
        : MATTER_RUN_ACTIONS.filter((value) => value === action || current.includes(value))
    )
  }

  /** 打开之后事项在别处被改过。**不自动跟到新版本**：那正是覆盖别人改动的那条路。 */
  const stale = matter.version !== baseVersion

  const reload = (): void => {
    setBaseVersion(matter.version)
    setAgentOn(matter.agent_enabled === true || matter.agent_enabled === 1)
    setTriggerDraft(parseTriggerEntries(matter.schedule_json))
    setActionsDraft(parseRunActions(matter.schedule_json))
    setProfileId(matter.agent_profile_id ?? BUILTIN_PROFILE_VALUE)
    setAgentDraft(agentDraftFrom(matter.schedule_json))
    setInstructions(matter.matter_instructions ?? '')
    setSaveError(null)
  }

  const save = (): void => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    // 🔴 成功才关：先关再等 mutation 的话，网络错误 / 版本冲突时四个字段的编辑全丢，
    // 用户只剩一个 toast，重来一遍才知道又失败。
    onPatch(
      {
        agent_enabled: agentOn,
        agent_profile_id: profileId === BUILTIN_PROFILE_VALUE ? null : profileId,
        matter_instructions: instructions.trim() ? instructions : null,
        schedule_json: buildTriggerEnvelope(triggerDraft, actionsDraft, agentOverrides)
      },
      baseVersion
    ).then(
      () => {
        setSaving(false)
        // G-33 —— 设计 §2.23「跟进规则已保存 · {label}」：把生效的排程一起说出来，模态关掉之后
        // 用户还能确认自己刚设的是什么。不带撤销（patch 的 undo descriptor 会把四个字段整体
        // 回滚，与"撤销这次排程改动"不是一回事，且改配置本就可以再改回来）。
        toastSuccess(t('matters.toast.agentRuleSaved', { label: planLabel }))
        onClose()
      },
      (error: unknown) => {
        setSaving(false)
        setSaveError(errorMessage(error))
      }
    )
  }

  return (
    <div
      // 根节点上已经有一个 ref（focus trap 的 fallback），动效 scope 只能与它并存 ——
      // 内联合并两个 ref，而不是给某一方另找宿主节点（会改 DOM 结构与布局）。
      ref={(node) => {
        scopeRef.current = node
        animScopeRef.current = node
      }}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="presentation"
    >
      {/* 用 div 而不是 section：`useFocusTrap` 的 ref 是 HTMLDivElement，且 role="dialog"
          已经把语义说全了。 */}
      <div
        ref={dialogRef}
        data-anim-card
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-agent-config-title"
        inert={globalAgentOpen || undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
            return
          }
          handleTab(event)
        }}
        /* 高度钳在视口内、内容区滚动 —— 触发编辑器展开后内容会长，外层 place-items-center
           会把 footer 顶出视口（同 MatterCreateDialog 的实测坑）。 */
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-raised"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ink-border px-5 py-4">
          <div className="min-w-0">
            <h2
              id="matter-agent-config-title"
              className="flex items-center gap-2 text-lead font-semibold"
            >
              <Sparkles size={15} className="shrink-0 text-ai" />
              {t('matters.agentConfig.title')}
            </h2>
            <p className="mt-1 text-meta text-ink-fg-2">{t('matters.agentConfig.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
          <div className="flex items-center gap-2.5 rounded-[var(--r-card)] border border-ai/20 bg-ai/[0.06] px-3 py-2.5">
            <Sparkles size={15} className="shrink-0 text-ai" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-aux text-ink-fg">
                {profile?.title ?? t('matters.agentConfig.builtinTitle')}
              </div>
              <div className="mt-0.5 text-meta text-ink-fg-2">
                {t('matters.agentConfig.builtinSubtitle')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setGlobalAgentOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-meta text-ink-fg-1 hover:bg-ink-3"
            >
              <Settings size={12} />
              {t('matters.globalAgent.open')}
            </button>
            <Switch
              checked={agentOn}
              onCheckedChange={setAgentOn}
              aria-label={t('matters.agentConfig.toggle')}
            />
          </div>

          {dangling ? (
            <p className="mt-3 rounded-[var(--r-ctl)] bg-warn/10 px-2 py-1.5 text-meta text-warn">
              {t('matters.agentBinding.dangling')}
            </p>
          ) : null}

          {/* 打开之后事项被别处改过：提示重新载入，**不**替用户把新版本吞掉。 */}
          {stale ? (
            <div className="mt-3 flex items-center gap-2 rounded-[var(--r-ctl)] bg-warn/10 px-2 py-1.5 text-meta text-warn">
              <span className="min-w-0 flex-1">{t('matters.agentConfig.stale')}</span>
              <button
                type="button"
                onClick={reload}
                className="shrink-0 rounded-[var(--r-ctl)] px-2 py-1 font-medium underline-offset-2 hover:underline"
              >
                {t('matters.agentConfig.reload')}
              </button>
            </div>
          ) : null}

          <div
            className={cn('mt-4', !agentOn && 'pointer-events-none opacity-[0.42]')}
            inert={!agentOn || undefined}
          >
            {/* 设计 `matter-agent.jsx:394-426` 的顺序：**高级折叠在触发列表之前**（收起时
                只有一行字 + 覆盖计数，展开才是那个虚线框）。 */}
            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              aria-expanded={advancedOpen}
              aria-controls="matter-agent-advanced"
              className="flex items-center gap-1.5 text-meta text-ink-fg-2 hover:text-ink-fg"
            >
              <CollapseChevron expanded={advancedOpen} size={11} />
              {t('matters.agentConfig.advanced')}
              {!advancedOpen && overrideCount > 0 ? (
                <span className="rounded-full bg-warn/[0.14] px-1.5 py-px text-micro text-warn">
                  {t('matters.agentConfig.overrideCount', { count: overrideCount })}
                </span>
              ) : null}
            </button>
            <CollapsibleRegion
              expanded={advancedOpen}
              id="matter-agent-advanced"
              bodyClassName="mt-2 rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-fg/[0.02] p-3"
            >
              <label className="text-meta font-medium text-ink-fg-1" htmlFor="matter-agent-profile">
                {t('matters.agentConfig.profileLabel')}
              </label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger id="matter-agent-profile" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BUILTIN_PROFILE_VALUE}>
                    {t('matters.agentBinding.builtinOption')}
                  </SelectItem>
                  {profiles.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {profiles.length === 0 ? (
                <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                  {t('matters.agentBinding.empty')}
                </p>
              ) : null}

              {/* 模型三项（0813 dogfood 轮 3 #10）。清单与 chat 模型选择器同源，控件沿用各
                  Agent 抽屉共用的 `ModelSelectItems`（分组 + 孤儿标注 + registry flag 都在里面）
                  —— composer 那个图标钮表达不了「跟随」这一档，而覆盖面必须能说"没配过"。 */}
              <label
                className="mt-3 block text-meta font-medium text-ink-fg-1"
                htmlFor="matter-agent-model"
              >
                {t('matters.agentConfig.modelLabel')}
              </label>
              <Select
                value={agentDraft.model}
                onValueChange={(value) =>
                  setAgentDraft((draft) => ({ ...draft, model: value }))
                }
              >
                <SelectTrigger id="matter-agent-model" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_VALUE}>
                    {t('matters.agentConfig.modelFollow')}
                  </SelectItem>
                  <ModelSelectItems models={modelRefs} current={modelOverride} />
                </SelectContent>
              </Select>

              <label
                className="mt-3 block text-meta font-medium text-ink-fg-1"
                htmlFor="matter-agent-effort"
              >
                {t('chat.effort.label')}
              </label>
              <Select
                value={effortValue}
                disabled={!effortApplicable}
                onValueChange={(value) =>
                  setAgentDraft((draft) => ({ ...draft, effort: value }))
                }
              >
                <SelectTrigger id="matter-agent-effort" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_VALUE}>
                    {t('matters.agentConfig.effortFollow')}
                  </SelectItem>
                  {(effortInfo?.options ?? []).map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {t(`chat.effort.tier.${tier}`)}
                      {tier === effortInfo?.defaultTier ? (
                        <span className="ml-1.5 text-ink-fg-3">{t('chat.effort.default')}</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* 🔴 灰掉必须把「为什么」说出来 —— 一个点不动又不解释的控件正是 owner 这批
                  反馈的病根。两种成因文案不同：还没选模型 / 这个模型不支持。 */}
              {!effortApplicable ? (
                <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                  {modelOverride
                    ? t('chat.effort.unsupported')
                    : t('matters.agentConfig.effortNeedsModel')}
                </p>
              ) : effortInfo?.passthroughUnknown ? (
                <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">{t('chat.effort.hedge')}</p>
              ) : null}

              <label
                className="mt-3 block text-meta font-medium text-ink-fg-1"
                htmlFor="matter-agent-fallback"
              >
                {t('matters.agentConfig.fallbackLabel')}
              </label>
              <Select
                value={agentDraft.fallback}
                onValueChange={(value) =>
                  setAgentDraft((draft) => ({ ...draft, fallback: value }))
                }
              >
                <SelectTrigger id="matter-agent-fallback" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_VALUE}>
                    {t('matters.agentConfig.fallbackFollow')}
                  </SelectItem>
                  <SelectItem value={NO_FALLBACK_VALUE}>
                    {t('matters.agentConfig.fallbackNone')}
                  </SelectItem>
                  <ModelSelectItems
                    models={modelRefs}
                    current={
                      agentDraft.fallback === FOLLOW_VALUE ||
                      agentDraft.fallback === NO_FALLBACK_VALUE
                        ? null
                        : agentDraft.fallback
                    }
                  />
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                {t('matters.agentConfig.fallbackHint')}
              </p>

              <label
                className="mt-3 block text-meta font-medium text-ink-fg-1"
                htmlFor="matter-agent-instructions"
              >
                {t('matters.agentConfig.instructionsLabel')}
              </label>
              <textarea
                id="matter-agent-instructions"
                maxLength={4000}
                rows={3}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={t('matters.agentConfig.instructionsPlaceholder')}
                className="mt-1.5 w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 p-2 text-aux leading-relaxed text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              />
              <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                {t('matters.agentConfig.instructionsHint')}
              </p>

              {/* 「被追加在谁之后」的那个"谁"，就地可读。只读：改的入口是上面那颗
                  「全局配置」，同一份文档两个可写面只会各改各的。 */}
              <button
                type="button"
                onClick={() => setContractOpen((value) => !value)}
                aria-expanded={contractOpen}
                aria-controls="matter-agent-contract"
                className="mt-2 flex items-center gap-1.5 text-meta text-ink-fg-2 hover:text-ink-fg"
              >
                <CollapseChevron expanded={contractOpen} size={11} />
                {t('matters.agentConfig.contractDisclosure')}
              </button>
              <CollapsibleRegion expanded={contractOpen} id="matter-agent-contract">
                {contractDoc.isLoading ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-meta text-ink-fg-3">
                    <Loader2 size={11} className="animate-spin" />
                    {t('common.loading')}
                  </p>
                ) : contractDoc.isError ? (
                  /* 🔴 失败必须说出来。静默留白正是 owner 把「有默认契约」读成
                     「完全没预设」的成因。 */
                  <p className="mt-1.5 text-meta leading-5 text-warn">
                    {t('matters.agentConfig.contractFailed')}
                  </p>
                ) : contractText ? (
                  <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-ctl)] border border-ink-border bg-ink-0/40 p-2 font-mono text-meta leading-relaxed text-ink-fg-2 scrollbar-thin">
                    {contractText}
                  </pre>
                ) : (
                  <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                    {t('matters.agentConfig.contractEmpty')}
                  </p>
                )}
              </CollapsibleRegion>
              {matter.agent_profile_id ? (
                <button
                  type="button"
                  onClick={() => {
                    setProfileId(BUILTIN_PROFILE_VALUE)
                    setAgentOn(false)
                  }}
                  className="mt-3 text-meta text-fail hover:underline"
                >
                  {t('matters.agentBinding.unbind')}
                </button>
              ) : null}
            </CollapsibleRegion>

            {/* 设计 `triggers.jsx:274-282` 的小标题行：左「触发方式」+ 右侧 ai 色推荐药丸。 */}
            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-meta font-medium text-ink-fg-1">
                {t('matters.agentConfig.triggerLabel')}
              </span>
              <button
                type="button"
                onClick={applyRecommended}
                className="inline-flex items-center gap-1.5 rounded-full border border-ai/25 bg-ai/[0.08] px-2.5 py-1 text-meta text-ai hover:bg-ai/[0.16]"
              >
                <Sparkles size={10} />
                {t('matters.agentBinding.recommended')}
              </button>
            </div>
            <div className="mt-1.5">
              <MatterTriggerEditor entries={triggerDraft} onChange={setTriggerDraft} />
            </div>

            {/* 「跟进时执行」（设计 §5.2 ACTIONS）。🔴 勾选定的是**产出什么**，不是能调用
                什么 —— 工具 allowlist 与「只观察与建议」的上限由服务端强制，勾 draft 也不会
                多一个发信工具。 */}
            <div className="mt-4">
              <span className="text-meta font-medium text-ink-fg-1">
                {t('matters.runActions.title')}
              </span>
              <div className="mt-1.5 space-y-0.5">
                {MATTER_RUN_ACTIONS.map((action) => (
                  <label
                    key={action}
                    className="flex cursor-pointer items-center gap-2.5 rounded-[var(--r-ctl)] px-1.5 py-1.5 hover:bg-ink-fg/[0.04]"
                  >
                    <Checkbox
                      checked={actionsDraft.includes(action)}
                      onCheckedChange={() => toggleAction(action)}
                    />
                    <span className="min-w-0 text-aux leading-5 text-ink-fg">
                      {t(`matters.runActions.${action}`)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <dl className="mt-4 space-y-1.5 border-t border-ink-border pt-3 text-meta">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-fg-3">{t('matters.agentBinding.plan')}</dt>
                <dd className="text-right text-ink-fg-1">{planLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-fg-3">{t('matters.agentBinding.next')}</dt>
                <dd className="text-ink-fg-1">
                  {next && next.kind === 'run' ? new Date(next.utcMs).toLocaleString() : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-fg-3">{t('matters.agentBinding.last')}</dt>
                <dd className="text-ink-fg-1">
                  {latest?.completed_at ? new Date(latest.completed_at).toLocaleString() : '—'}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <footer className="shrink-0 border-t border-ink-border px-5 py-3">
          {/* 保存失败留在模态里：草稿还在，改一改就能重试。 */}
          {saveError ? (
            <p
              role="alert"
              className="mb-2 rounded-[var(--r-ctl)] bg-fail/10 px-2 py-1.5 text-meta leading-5 text-fail"
            >
              {t('matters.toast.saveFailed')} · {saveError}
            </p>
          ) : null}
          <div className="flex items-center gap-2.5">
            <Shield size={12} className="shrink-0 text-ink-fg-3" />
            <span className="min-w-0 flex-1 text-meta leading-5 text-ink-fg-3">
              {agentOn
                ? t('matters.agentConfig.summaryActive', { plan: planLabel })
                : t('matters.agentConfig.summaryDisabled')}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--r-ctl)] px-3 py-1.5 text-body text-ink-fg-1 hover:bg-ink-3"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-body font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? t('matters.agentConfig.saving') : t('matters.agentConfig.save')}
            </button>
          </div>
        </footer>
      </div>
      {globalAgentOpen ? (
        <MatterGlobalAgentModal onClose={() => setGlobalAgentOpen(false)} />
      ) : null}
    </div>
  )
}
