import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Settings, Shield, Sparkles, X } from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import type { Matter, MatterPatchInput, MatterRun } from '@shared/api/types/matter'
import type { MatterRunAction } from '@shared/api/types/matter'
import { MATTER_RUN_ACTIONS } from '@shared/api/types/matter'
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
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'

import { MatterGlobalAgentModal } from './MatterGlobalAgentModal'
import { MatterTriggerEditor } from './MatterTriggerEditor'
import {
  buildTriggerEnvelope,
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
 * 设计画了「模型」「授权级别」两个 select，**刻意不做**：授权是服务端强制的（固定工具
 * allowlist + 只放行读与提案），per-matter 也没有模型字段 —— 做成 UI 开关就是又造一个
 * 说谎的界面（同 `MatterGlobalAgentModal` 的判断）。改用「执行的 Agent」（换 profile ⇒
 * 换模型/人设）这条**真实存在**的路径承载同一诉求。
 */

const BUILTIN_PROFILE_VALUE = '__builtin__'

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
  const [instructions, setInstructions] = useState(matter.matter_instructions ?? '')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [contractOpen, setContractOpen] = useState(false)
  const [globalAgentOpen, setGlobalAgentOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 「下次运行」的基准时刻挂载时冻结：render 期间调 Date.now() 会被 react-hooks/purity 拒绝。
  const [now] = useState(() => Date.now())
  const scopeRef = useRef<HTMLDivElement>(null)

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
  const latest = runs.find((run) => run.completed_at != null)
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
        schedule_json: buildTriggerEnvelope(triggerDraft, actionsDraft)
      },
      baseVersion
    ).then(
      () => {
        setSaving(false)
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
      ref={scopeRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="presentation"
    >
      {/* 用 div 而不是 section：`useFocusTrap` 的 ref 是 HTMLDivElement，且 role="dialog"
          已经把语义说全了。 */}
      <div
        ref={dialogRef}
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-meta font-medium text-ink-fg-1">
                {t('matters.agentConfig.triggerLabel')}
              </span>
              <button
                type="button"
                onClick={applyRecommended}
                className="rounded-[var(--r-ctl)] bg-ai/10 px-2 py-1 text-meta text-ai hover:bg-ai/[0.16]"
              >
                {t('matters.agentBinding.recommended')}
              </button>
            </div>
            {/* 设计的 Field hint（「事项级触发独立于全局 Agent」）与编辑器自己那句
                `trigger.independentHint` 是同一个意思，只保留后者 —— 后者还多说了「多条可
                并存」，正是本仓与设计单选模型的差别所在。 */}
            <div className="mt-2">
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

            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              aria-expanded={advancedOpen}
              aria-controls="matter-agent-advanced"
              className="mt-4 flex items-center gap-1.5 text-meta text-ink-fg-2 hover:text-ink-fg"
            >
              <CollapseChevron expanded={advancedOpen} size={11} />
              {t('matters.agentConfig.advanced')}
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
              {saving ? t('matters.agentConfig.saving') : t('common.save')}
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
