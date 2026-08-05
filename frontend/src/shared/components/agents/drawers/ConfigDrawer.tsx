// Sprint 20 — /agents 报告 agent 配置抽屉：机械抽自 AgentsTab.tsx（原样搬迁，零行为变化）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AgentAvatarConfig,
  ReportAgentConfig,
  ReportCadence,
  ReportConfigPatch
} from '@shared/api/types'
import { CadencePill, ReportIcon, Switch } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useKosAvailable, useSetConfig } from '../hooks'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@shared/components/ui/select'
import { PREPROCESS_DOCS } from '../shared'
import { Field } from './Field'
import { ModelSelectItems } from './ModelSelectItems'
import {
  ScheduleBuilder,
  type ScheduleValue,
  hostTimezone,
  readReportSchedule,
  writeReportSchedule
} from '../schedule'

// 顺序固定，与 src/llm_agent/schema.py PRIORITY_ENUM 对齐 —— 勾选的优先级邮件带完整正文。
// value 是与后端 body_full_priorities 配置比较的权威值（一字不改）；显示文案走 i18n key。
const PRIORITY_ENUM = ['🔴 紧急', '🟡 重要', '🟢 一般', '⚪ 低'] as const
const PRIORITY_LABEL_KEYS: Record<string, string> = {
  '🔴 紧急': 'agents.config.priority.critical',
  '🟡 重要': 'agents.config.priority.important',
  '🟢 一般': 'agents.config.priority.normal',
  '⚪ 低': 'agents.config.priority.low'
}

// ─── 配置 slide-over ─────────────────────────────────────────────────────────
// export for component tests (tests/components/AgentsConfigDrawer.test.tsx);
// 主流程仍只经 AgentsTab 内部使用。
export function ConfigDrawer({
  cfg,
  open,
  onClose,
  onOpenReports
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  onClose: () => void
  /** R5 — 跳到「报告」tab 浏览该 agent 的完整执行历史（辅助优化提示词时回看过往报告）。
   *  可选：AgentsTab 恒传；缺省（如独立测试直接渲染）则不显「查看全部历史」入口。 */
  onOpenReports?: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const [saveFailed, setSaveFailed] = useState(false)

  // cadence + title 进 state（渲染期不读 cfg，退场时 cfg→null 也不崩）；useEffect 按 cfg 预填。
  // cadence 仍是**只读**的报告种类（CadencePill 展示 + 驱动 daily/周月分支）；07-24 起排程
  // 本身交给 ScheduleBuilder，但构建器的 freq 段被锁死（lockFreq），不让用户在这里改报告种类。
  const [cadence, setCadence] = useState<ReportCadence>('daily')
  const [title, setTitle] = useState('')
  // 头像身份（0804 dogfood 3d）：与 title 同纪律进 state —— 退场期 cfg→null 时头像不能
  // 跳回「按空 id 派生」的另一张脸（agentId 也一并 state 化）。avatarDirty 才写 patch。
  const [agentId, setAgentId] = useState('')
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)

  // useState 初始化为中性默认；真正预填由下方 useEffect 在 open 时按 cfg 灌入。这样
  // 退场期间(open=false, cfg→null)不会重置，重开能正确反映目标 agent。
  const [enabled, setEnabled] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  // 排程（07-24 起结构化规则，与 custom agent 共用 ScheduleBuilder）。老 `schedule_json`
  // 读时惰性迁移（readReportSchedule），**不回写 DB**。
  const [schedule, setSchedule] = useState<ScheduleValue>(() =>
    readReportSchedule({ cadence: 'daily', hours: [9] }, hostTimezone())
  )
  const [triggerMode, setTriggerMode] = useState<'rolling_24h' | 'natural_day'>('rolling_24h')
  // 带完整正文的优先级集合；空配置回落到默认（紧急 + 重要）。
  const [bodyPriorities, setBodyPriorities] = useState<string[]>(['🔴 紧急', '🟡 重要'])
  // 注入报告 system prompt 的身份文档勾选（增量 2，与 PreprocessConfigDrawer 同语义：
  // 投影层已把 NULL 行回填默认 ['soul','user']，[] = 显式不注入）。
  const [contextDocs, setContextDocs] = useState<string[]>([])
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>('')
  const [kosEnrich, setKosEnrich] = useState(false)
  // 仅当 Gbrain（KOS）已配好（KOS_MCP_BASE + OAuth）才展示增强开关。
  const kosAvailable = useKosAvailable()

  // 打开时按 cfg 预填（参考 EventFormModal）。依赖 [open, cfg]：open 切 true 或切换
  // 不同 agent(cfg 变) 时重置；关闭时 if(!open) 提前返回，保留旧值供退场动画。
  useEffect(() => {
    if (!open || !cfg) return
    setSaveFailed(false)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 模态打开按 cfg 预填表单（多字段响应 open&&cfg 变化）。React Compiler 迁移债：真重构需父组件 key 重置 remount + 预填逻辑搬 useState initializer，等价性风险（occurrence vs create defaults 各转换）高于收益。effect 合理保留。
    setCadence(cfg.schedule.cadence)
    setTitle(cfg.title)
    setAgentId(cfg.id)
    setAvatar(cfg.avatar ?? null)
    setAvatarDirty(false)
    setEnabled(cfg.enabled)
    setPrompt(cfg.prompt)
    setPromptDirty(false)
    // 🔴 空时区写实成宿主机 IANA（契约 §4）：报告 agent 空时区的历史语义就是宿主机本地，
    // 留空会让统一后的逻辑退化成 UTC，现有 9:00 报告直接漂到别的时刻。
    setSchedule(readReportSchedule(cfg.schedule, cfg.timezone || hostTimezone()))
    setTriggerMode(cfg.trigger_mode || 'rolling_24h')
    setBodyPriorities(
      cfg.body_full_priorities?.length ? cfg.body_full_priorities : ['🔴 紧急', '🟡 重要']
    )
    setContextDocs(cfg.context_docs ?? [])
    setModel(cfg.model || '')
    setKosEnrich(cfg.kos_enrich)
  }, [open, cfg])

  const isDaily = cadence === 'daily'

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px'
  }

  const onSave = (): void => {
    if (!cfg) return
    setSaveFailed(false)
    const patch: ReportConfigPatch = {
      enabled,
      // prompt 未改且仍是默认态 → 传 null 保持"用默认"；改过 → 传文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      kos_enrich: kosEnrich,
      context_docs: contextDocs,
      // 老键先铺（保留后端可能存的未知键），再由 writeReportSchedule 覆盖权威字段。
      // cadence 恒 = rule.freq，而 freq 段被 lockFreq 锁死 → 报告种类不会被排程编辑改掉。
      schedule: { ...cfg.schedule, ...writeReportSchedule(schedule) }
    }
    // 头像：未触碰不发（PATCH 缺席 = 不动列），避免把 NULL 行写成显式派生值。
    if (avatarDirty) patch.avatar = avatar
    // 触发模式 / 时区 / 带正文优先级仅 daily 有意义；周月报走层级聚合，不带这些。
    if (isDaily) {
      patch.trigger_mode = triggerMode
      patch.body_full_priorities = bodyPriorities
      // 时区只在 natural_day 有意义；rolling_24h 固定回溯 24h、不读时区，显式清空。
      // 值取自构建器 —— 抽屉里只有一个时区选择器，避免「排程时区」与「自然日边界时区」
      // 两个来源静默分歧。既有空值同样按契约 §4 写实成宿主机 IANA（行为等价、不再漂）。
      patch.timezone = triggerMode === 'natural_day' ? schedule.timezone : ''
    }
    void save(cfg.id, patch)
      .then(onClose)
      .catch(() => setSaveFailed(true))
  }

  return (
    <Drawer open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <header
        className="flex items-center"
        style={{
          gap: 10,
          padding: '15px 18px',
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0
        }}
      >
        <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
          <ReportIcon name="cog" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.config.title', { title })}
        </h2>
        {/* R5 — 「查看全部历史」→ 跳报告 tab 浏览完整执行记录（含失败态）。切 tab 会卸载
              本抽屉所在的 agents tab，无需先播退场动画。onOpenReports 缺省时不渲染。 */}
        {onOpenReports && (
          <button
            type="button"
            onClick={onOpenReports}
            className="flex items-center"
            style={{
              gap: 5,
              fontFamily: 'inherit',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 7,
              cursor: 'pointer',
              color: 'rgb(var(--ink-fg-2))',
              background: 'rgb(var(--ink-fg) / 0.05)',
              border: '1px solid rgb(var(--ink-border-soft))'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgb(var(--c-accent))')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgb(var(--ink-fg-2))')}
          >
            <ReportIcon name="clock" size={13} />
            {t('agents.config.viewHistory')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('agents.source.close')}
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 28,
            height: 28,
            borderRadius: 7,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'rgb(var(--ink-fg-2))'
          }}
        >
          <ReportIcon name="x" size={16} />
        </button>
      </header>

      <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* enable */}
          <div
            className="flex items-center"
            style={{
              gap: 12,
              padding: '13px 14px',
              borderRadius: 10,
              background: 'rgb(var(--ink-2) / 0.55)',
              border: '1px solid rgb(var(--ink-border))'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                {t('agents.config.enable')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.config.enableHint')}
              </div>
            </div>
            <Switch on={enabled} onChange={setEnabled} />
          </div>

          {/* 头像 + 名称（0804 dogfood 3d/3e）—— 报告 Agent 的名称在抽屉里一直是只读
              （种类由 cadence 决定），故只并排展示，保存 patch 只带 avatar。 */}
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={agentId}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={title}
            />
          </Field>

          {/* prompt */}
          <Field label={t('agents.config.prompt')} hint={t('agents.config.promptHint')}>
            <textarea
              value={prompt}
              placeholder={t('agents.config.promptPlaceholder')}
              onChange={(e) => {
                setPrompt(e.target.value)
                setPromptDirty(true)
              }}
              rows={11}
              className="scrollbar-thin"
              style={{
                ...inputStyle,
                resize: 'vertical',
                lineHeight: 1.6,
                fontSize: 13,
                minHeight: 200
              }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 6,
                lineHeight: 1.5
              }}
            >
              {t('agents.config.promptNote')}
            </div>
          </Field>

          {/* 文档勾选（cfg.context_docs）—— 注入报告 system prompt 的身份文档（增量 2，
                与 PreprocessConfigDrawer 同款 chips + 同语义：[] = 显式不注入） */}
          <Field label={t('agents.config.contextDocs')} hint={t('agents.config.contextDocsHint')}>
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
              {PREPROCESS_DOCS.map((doc) => {
                const on = contextDocs.includes(doc)
                return (
                  <button
                    key={doc}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setContextDocs((prev) =>
                        prev.includes(doc) ? prev.filter((x) => x !== doc) : [...prev, doc]
                      )
                    }
                    style={{
                      padding: '6px 12px',
                      borderRadius: 8,
                      fontFamily: 'inherit',
                      fontSize: 13,
                      cursor: 'pointer',
                      color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                      background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                      border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                      transition:
                        'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
                    }}
                  >
                    {t(`agents.preprocess.doc.${doc}`)}
                  </button>
                )
              })}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 7,
                lineHeight: 1.5
              }}
            >
              {t('agents.config.contextDocsNote')}
            </div>
          </Field>

          {/* schedule —— 07-24 起与 custom agent 共用 ScheduleBuilder。
              CadencePill 保留在上方展示报告种类（只读，构建器的 freq 段被 lockFreq 锁死）。
              时区选择器由构建器提供（natural_day 的边界时区同源，见 onSave）。 */}
          <Field label={t('agents.config.schedule')} hint={t('agents.schedule.hint')}>
            <div className="flex items-center" style={{ gap: 10, marginBottom: 12 }}>
              <CadencePill cadence={cadence} />
            </div>
            <ScheduleBuilder value={schedule} onChange={setSchedule} lockFreq />
          </Field>

          {isDaily ? (
            <>
              {/* 触发模式 */}
              <Field label={t('agents.config.triggerMode')} hint={t('agents.config.triggerHint')}>
                <div className="seg" style={{ width: '100%' }}>
                  {(['rolling_24h', 'natural_day'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={triggerMode === mode ? 'on' : ''}
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => setTriggerMode(mode)}
                    >
                      {t(`agents.config.trigger.${mode}`)}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 时区选择器已上移进 ScheduleBuilder（natural_day 的边界时区与排程时区同源，
                  见 onSave）。这里只提示它对自然日边界也生效，避免用户以为只管触发时刻。 */}
              {triggerMode === 'natural_day' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    lineHeight: 1.5,
                    padding: '9px 12px',
                    borderRadius: 9,
                    background: 'rgb(var(--ink-1) / 0.5)',
                    border: '1px solid rgb(var(--ink-border-soft))'
                  }}
                >
                  {t('agents.config.timezoneFromSchedule', { tz: schedule.timezone })}
                </div>
              )}

              {/* 带正文的优先级（多选 chip）—— 命中的邮件带完整正文，其余只摘要、不带附件 */}
              <Field
                label={t('agents.config.bodyPriorities')}
                hint={t('agents.config.bodyPrioritiesHint')}
              >
                <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {PRIORITY_ENUM.map((p) => {
                    const on = bodyPriorities.includes(p)
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setBodyPriorities((prev) =>
                            prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                          )
                        }
                        style={{
                          padding: '6px 12px',
                          borderRadius: 8,
                          fontFamily: 'inherit',
                          fontSize: 13,
                          cursor: 'pointer',
                          color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                          background: on
                            ? 'rgb(var(--c-accent) / 0.14)'
                            : 'rgb(var(--ink-1) / 0.5)',
                          border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                          transition:
                            'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
                        }}
                      >
                        {p in PRIORITY_LABEL_KEYS ? t(PRIORITY_LABEL_KEYS[p]) : p}
                      </button>
                    )
                  })}
                </div>
              </Field>
            </>
          ) : (
            <Field label={t('agents.config.aggregation')}>
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: 'rgb(var(--ink-fg-2))',
                  padding: '11px 13px',
                  borderRadius: 9,
                  background: 'rgb(var(--ink-1) / 0.5)',
                  border: '1px solid rgb(var(--ink-border-soft))'
                }}
              >
                {cadence === 'weekly'
                  ? t('agents.config.aggWeekly')
                  : t('agents.config.aggMonthly')}
              </div>
            </Field>
          )}

          {/* model — single-select dropdown. Options = enabled set, plus the
                current value appended as an orphan (annotated「（未启用）」) when it
                is no longer in the enabled list, so the select still shows the
                actual saved value instead of going blank. Mirrors AiTab's
                LLM_MODEL select shape. */}
          <Field label={t('agents.config.model')}>
            {/* aria-label：抽屉里现在有两个 Radix Select（排程时区 + 模型），无标签时
                role=combobox 查询会撞车。给两边都挂 label，读屏与测试都能精确定位。 */}
            <Select value={model || undefined} onValueChange={setModel}>
              <SelectTrigger aria-label={t('agents.config.model')}>
                <SelectValue placeholder={t('agents.config.model')} />
              </SelectTrigger>
              {/* z-[70]: 本抽屉 (ConfigDrawer) backdrop/panel 是 z-60/61，高于 Radix
                    Select content 默认的 z-50 (popover 约定层，仅够 clear z-40 的 Settings
                    Dialog)。不抬高 → 下拉 portal 到 body 后落在抽屉之下被 glass 面板挡住，
                    表现为「点不开/无法切换」。70 介于抽屉(61)与 lightbox(100)之间。 */}
              <SelectContent className="z-[70]">
                <ModelSelectItems models={enabledModels} current={model || null} />
              </SelectContent>
            </Select>
          </Field>

          {/* kos enrich —— 仅 Gbrain 已配好时展示 */}
          {kosAvailable && (
            <div
              className="flex items-center"
              style={{
                gap: 12,
                padding: '13px 14px',
                borderRadius: 10,
                background: 'rgb(var(--c-ai) / 0.06)',
                border: '1px solid rgb(var(--c-ai) / 0.22)'
              }}
            >
              <span style={{ color: 'rgb(var(--c-ai))', flexShrink: 0 }}>
                <ReportIcon name="database" size={16} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                  {t('agents.config.kos')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.config.kosHint')}
                </div>
              </div>
              <Switch on={kosEnrich} onChange={setKosEnrich} />
            </div>
          )}
        </div>
      </div>

      <footer
        className="flex items-center"
        style={{
          gap: 10,
          padding: '13px 18px',
          borderTop: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0,
          justifyContent: 'flex-end'
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost"
          style={{ fontFamily: 'inherit' }}
        >
          {t('agents.config.cancel')}
        </button>
        <StatefulButton
          type="button"
          onClick={onSave}
          disabled={isSaving}
          state={isSaving ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
