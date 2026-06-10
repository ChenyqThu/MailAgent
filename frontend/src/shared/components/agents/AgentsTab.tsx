// Sprint 20 — Agents tab：邮件日报 agent 概览卡（启用/运行/配置 + 最近报告）+
// 配置 slide-over（prompt / 排程 / 触发模式 / 带正文优先级 / 模型 / KOS 增强）+ 新建占位。
// 移植自 ~/Downloads/agents/agents-tab.jsx，接 report:getConfig/setConfig/runNow。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig, ReportCadence, ReportConfigPatch } from '@shared/api/types'
import { CadencePill, ReportIcon, StatusBadge, Switch } from './primitives'
import { useKosAvailable, useReportConfig, useReportList, useRunNow, useSetConfig } from './hooks'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'

const HOUR_OPTIONS = [6, 7, 8, 9, 10, 12, 18, 21]
// weekday：与后端 worker.py 一致，Python datetime.weekday() 口径 0=周一 … 6=周日。
const WEEKDAY_OPTIONS = [0, 1, 2, 3, 4, 5, 6]
// day_of_month：后端 worker 用 now.day 精确匹配、无月末回退 → 限 1–28，保证每月都触发。
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1)
// 顺序固定，与 src/llm_agent/schema.py PRIORITY_ENUM 对齐 —— 勾选的优先级邮件带完整正文。
const PRIORITY_ENUM = ['🔴 紧急', '🟡 重要', '🟢 一般', '⚪ 低'] as const

function scheduleText(
  cfg: ReportAgentConfig,
  t: (k: string, o?: Record<string, unknown>) => string
): string {
  const h = String(cfg.schedule.hours?.[0] ?? 9).padStart(2, '0')
  if (cfg.schedule.cadence === 'weekly') {
    const wd = cfg.schedule.weekday ?? 0
    return t('agents.card.schedWeekly', { hour: h, weekday: t(`agents.config.weekday.${wd}`) })
  }
  if (cfg.schedule.cadence === 'monthly') {
    return t('agents.card.schedMonthly', { hour: h, day: cfg.schedule.day_of_month ?? 1 })
  }
  return t('agents.card.schedDaily', { hour: h })
}

// ─── 概览卡 ─────────────────────────────────────────────────────────────────
function AgentCard({
  cfg,
  onConfig,
  onOpenReports
}: {
  cfg: ReportAgentConfig
  onConfig: () => void
  onOpenReports: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save } = useSetConfig()
  const { run, isRunning } = useRunNow()
  const { items } = useReportList()
  // 该 agent 的最近一份报告（items 按 report_date 倒序 → find 命中即最新）。
  const last = useMemo(() => items.find((it) => it.agent_id === cfg.id) ?? null, [items, cfg.id])

  const toggle = (v: boolean): void => {
    void save(cfg.id, { enabled: v })
  }
  const runNow = (): void => {
    if (!isRunning) void run(cfg.id)
  }
  // dynamic-models: show the raw model id (no static label lookup needed).
  const modelLabel = cfg.model ?? ''

  return (
    <div
      style={{
        borderRadius: 14,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))',
        overflow: 'hidden'
      }}
    >
      {/* head */}
      <div className="flex items-center" style={{ gap: 13, padding: '18px 20px 16px' }}>
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            background: 'rgb(var(--c-accent) / 0.14)',
            border: '1px solid rgb(var(--c-accent) / 0.30)',
            color: 'rgb(var(--c-accent))'
          }}
        >
          <ReportIcon name="sparkles" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: 9 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
              {cfg.title}
            </h3>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 5,
                color: cfg.enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))',
                background: cfg.enabled ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--ink-fg) / 0.05)',
                border: `1px solid ${cfg.enabled ? 'rgb(var(--c-ok) / 0.25)' : 'rgb(var(--ink-border))'}`
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: cfg.enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))'
                }}
              />
              {cfg.enabled ? t('agents.card.enabled') : t('agents.card.disabled')}
            </span>
          </div>
          <div
            className="flex items-center"
            style={{
              gap: 8,
              marginTop: 4,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11.5,
              color: 'rgb(var(--ink-fg-2))'
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ReportIcon name="clock" size={11} />
              {scheduleText(cfg, t)}
            </span>
            {/* 回看窗口仅对日报有意义；周/月报走层级聚合（综合上周日报/上月周报），不显示 */}
            {cfg.schedule.cadence === 'daily' ? (
              <>
                <span>·</span>
                <span>{t('agents.card.window', { hours: cfg.window_hours ?? 24 })}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{modelLabel}</span>
          </div>
        </div>
        <Switch on={cfg.enabled} onChange={toggle} />
      </div>

      {/* last report */}
      <div
        style={{
          margin: '0 20px',
          padding: '13px 0',
          borderTop: '1px solid rgb(var(--ink-border-soft))'
        }}
      >
        <div
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'rgb(var(--ink-fg-3))',
            marginBottom: 8
          }}
        >
          {t('agents.card.lastReport')}
        </div>
        {last ? (
          <button
            type="button"
            onClick={onOpenReports}
            className="flex items-center"
            style={{
              gap: 11,
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 9,
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: 'rgb(var(--ink-1))',
              border: '1px solid rgb(var(--ink-border-soft))',
              transition: 'border-color 120ms'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--ink-border))')}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = 'rgb(var(--ink-border-soft))')
            }
          >
            <span
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                color: 'rgb(var(--ink-fg-2))',
                flexShrink: 0
              }}
            >
              {last.report_date.slice(5).replace('-', '/')}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 13,
                color: 'rgb(var(--ink-fg-1))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {last.headline}
            </span>
            <StatusBadge status={last.status} />
            <ReportIcon
              name="chevronright"
              size={14}
              style={{ color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}
            />
          </button>
        ) : (
          <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-3))', padding: '4px 0' }}>
            {t('agents.card.noReport')}
          </div>
        )}
      </div>

      {/* actions */}
      <div
        className="flex items-center"
        style={{
          gap: 10,
          padding: '14px 20px',
          borderTop: '1px solid rgb(var(--ink-border-soft))',
          background: 'rgb(var(--ink-1) / 0.4)'
        }}
      >
        <button
          type="button"
          onClick={runNow}
          disabled={isRunning}
          className="flex items-center"
          style={{
            gap: 7,
            padding: '8px 15px',
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 13.5,
            fontWeight: 500,
            cursor: isRunning ? 'wait' : 'pointer',
            color: 'rgb(var(--c-cta-fg))',
            background: 'rgb(var(--c-cta-bg))',
            border: 0
          }}
          onMouseEnter={(e) => {
            if (!isRunning) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
          }}
        >
          {isRunning ? (
            <>
              <span className="spin" style={{ display: 'flex' }}>
                <ReportIcon name="loader" size={14} />
              </span>
              {t('agents.card.running')}
            </>
          ) : (
            <>
              <ReportIcon name="play" size={13} />
              {t('agents.card.runNow')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onConfig}
          className="flex items-center"
          style={{
            gap: 7,
            padding: '8px 15px',
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 13.5,
            cursor: 'pointer',
            color: 'rgb(var(--ink-fg-1))',
            background: 'transparent',
            border: '1px solid rgb(var(--ink-border))'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgb(var(--ink-4))')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <ReportIcon name="cog" size={14} />
          {t('agents.card.configure')}
        </button>
        <span style={{ flex: 1 }} />
        {isRunning && (
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11.5,
              color: 'rgb(var(--ink-fg-3))'
            }}
          >
            {t('agents.card.runningHint')}
          </span>
        )}
      </div>
    </div>
  )
}

function NewAgentTile(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px dashed rgb(var(--ink-border))',
        padding: '22px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        opacity: 0.7
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 11,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          background: 'rgb(var(--ink-3))',
          color: 'rgb(var(--ink-fg-3))'
        }}
      >
        <ReportIcon name="plus" size={20} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'rgb(var(--ink-fg-2))' }}>
          {t('agents.card.newAgent')}
        </div>
        <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
          {t('agents.card.newAgentHint')}
        </div>
      </div>
      <span
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 10.5,
          color: 'rgb(var(--ink-fg-3))',
          padding: '3px 8px',
          borderRadius: 5,
          background: 'rgb(var(--ink-fg) / 0.04)',
          border: '1px solid rgb(var(--ink-border))'
        }}
      >
        v1.x
      </span>
    </div>
  )
}

// ─── 配置 slide-over ─────────────────────────────────────────────────────────
// export for component tests (tests/components/AgentsConfigDrawer.test.tsx);
// 主流程仍只经 AgentsTab 内部使用。
export function ConfigDrawer({
  cfg,
  open,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()

  // 进/退场动效：遮罩与 aside 同步进退 —— 遮罩淡入与抽屉右滑同走 DUR.base、同 standard
  // 曲线、同起止（syncBackdrop），避免"遮罩先啪一下、抽屉再慢慢滑"脱节；退场对称、
  // 可中断、自动尊重 reduced-motion（DESIGN.md §8 / docs/motion-gsap.md）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  // cadence + title 进 state（渲染期不读 cfg，退场时 cfg→null 也不崩）；useEffect 按 cfg 预填。
  const [cadence, setCadence] = useState<ReportCadence>('daily')
  const [title, setTitle] = useState('')

  // useState 初始化为中性默认；真正预填由下方 useEffect 在 open 时按 cfg 灌入。这样
  // 退场期间(open=false, cfg→null)不会重置，重开能正确反映目标 agent。
  const [enabled, setEnabled] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [hour, setHour] = useState<number>(9)
  // weekly 选周几（0=周一…6=周日，与 worker.py 一致）；monthly 选每月几日（1–28）。
  const [weekday, setWeekday] = useState<number>(0)
  const [dayOfMonth, setDayOfMonth] = useState<number>(1)
  const [triggerMode, setTriggerMode] = useState<'rolling_24h' | 'natural_day'>('rolling_24h')
  const [timezone, setTimezone] = useState<string>('')
  // 带完整正文的优先级集合；空配置回落到默认（紧急 + 重要）。
  const [bodyPriorities, setBodyPriorities] = useState<string[]>(['🔴 紧急', '🟡 重要'])
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>('')
  const [kosEnrich, setKosEnrich] = useState(false)
  // 仅当 Gbrain（KOS）已配好（KOS_MCP_BASE + OAuth）才展示增强开关。
  const kosAvailable = useKosAvailable()

  // 打开时按 cfg 预填（参考 EventFormModal）。依赖 [open, cfg]：open 切 true 或切换
  // 不同 agent(cfg 变) 时重置；关闭时 if(!open) 提前返回，保留旧值供退场动画。
  useEffect(() => {
    if (!open || !cfg) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 模态打开按 cfg 预填表单（多字段响应 open&&cfg 变化）。React Compiler 迁移债：真重构需父组件 key 重置 remount + 预填逻辑搬 useState initializer，等价性风险（occurrence vs create defaults 各转换）高于收益。effect 合理保留。
    setCadence(cfg.schedule.cadence)
    setTitle(cfg.title)
    setEnabled(cfg.enabled)
    setPrompt(cfg.prompt)
    setPromptDirty(false)
    setHour(cfg.schedule.hours?.[0] ?? 9)
    setWeekday(cfg.schedule.weekday ?? 0)
    setDayOfMonth(cfg.schedule.day_of_month ?? 1)
    setTriggerMode(cfg.trigger_mode || 'rolling_24h')
    setTimezone(cfg.timezone || '')
    setBodyPriorities(
      cfg.body_full_priorities?.length ? cfg.body_full_priorities : ['🔴 紧急', '🟡 重要']
    )
    setModel(cfg.model || '')
    setKosEnrich(cfg.kos_enrich)
  }, [open, cfg])

  if (!shouldRender) return null

  const isDaily = cadence === 'daily'

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1))',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px',
    outline: 'none'
  }

  const onSave = (): void => {
    if (!cfg) return
    const patch: ReportConfigPatch = {
      enabled,
      // prompt 未改且仍是默认态 → 传 null 保持"用默认"；改过 → 传文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      kos_enrich: kosEnrich,
      schedule: {
        ...cfg.schedule,
        cadence,
        hours: [hour],
        // weekday 仅 weekly 有意义、day_of_month 仅 monthly 有意义；按 cadence 写入。
        ...(cadence === 'weekly' ? { weekday } : {}),
        ...(cadence === 'monthly' ? { day_of_month: dayOfMonth } : {})
      }
    }
    // 触发模式 / 时区 / 带正文优先级仅 daily 有意义；周月报走层级聚合，不带这些。
    if (isDaily) {
      patch.trigger_mode = triggerMode
      patch.body_full_priorities = bodyPriorities
      // 时区只在 natural_day 有意义；rolling_24h 固定回溯 24h、不读时区，显式清空。
      patch.timezone = triggerMode === 'natural_day' ? timezone.trim() : ''
    }
    void save(cfg.id, patch).then(onClose)
  }

  return (
    <div
      ref={scopeRef}
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.4)' }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '92%',
          zIndex: 61,
          background: 'rgb(var(--ink-1))',
          borderLeft: '1px solid rgb(var(--ink-border))',
          boxShadow: 'var(--shadow-raised)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
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
                background: 'rgb(var(--ink-2))',
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

            {/* schedule：daily 只选时点；weekly 选周几 + 时点；monthly 选每月几日 + 时点 */}
            <Field label={t('agents.config.schedule')}>
              <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
                <CadencePill cadence={cadence} />
                {cadence === 'daily' && (
                  <span style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))' }}>
                    {t('agents.config.at')}
                  </span>
                )}
                {cadence === 'weekly' && (
                  <select
                    value={weekday}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                    style={{ ...inputStyle, width: 'auto' }}
                    aria-label={t('agents.config.weekdayLabel')}
                  >
                    {WEEKDAY_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {t(`agents.config.weekday.${d}`)}
                      </option>
                    ))}
                  </select>
                )}
                {cadence === 'monthly' && (
                  <select
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                    style={{ ...inputStyle, width: 'auto' }}
                    aria-label={t('agents.config.dayOfMonthLabel')}
                  >
                    {DAY_OF_MONTH_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {t('agents.config.dayOfMonthN', { day: d })}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  style={{ ...inputStyle, width: 'auto', flex: 1 }}
                >
                  {HOUR_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </div>
              {cadence === 'monthly' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 6,
                    lineHeight: 1.5
                  }}
                >
                  {t('agents.config.dayOfMonthHint')}
                </div>
              )}
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

                {/* 时区（仅 natural_day：rolling_24h 固定回溯 24h、不需要时区） */}
                {triggerMode === 'natural_day' && (
                  <Field label={t('agents.config.timezone')} hint={t('agents.config.timezoneHint')}>
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">{t('agents.config.timezoneLocal')}</option>
                      {Intl.supportedValuesOf('timeZone').map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </Field>
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
                            background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1))',
                            border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                            transition: 'all 120ms'
                          }}
                        >
                          {p}
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
                    background: 'rgb(var(--ink-1))',
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
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                <SelectContent>
                  {(model && !enabledModels.includes(model)
                    ? [...enabledModels, model]
                    : enabledModels
                  ).map((id) => {
                    const isOrphan = !enabledModels.includes(id)
                    return (
                      <SelectItem key={id} value={id}>
                        {id}
                        {isOrphan && (
                          <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
                            {t('settings.ai.enabledModels.notEnabled', {
                              defaultValue: '（未启用）'
                            })}
                          </span>
                        )}
                      </SelectItem>
                    )
                  })}
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
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: isSaving ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0
            }}
            onMouseEnter={(e) => {
              if (!isSaving) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
            }}
          >
            {t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

// ─── tab ─────────────────────────────────────────────────────────────────────
export function AgentsTab({ onOpenReports }: { onOpenReports: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const { agents, isLoading } = useReportConfig()
  const [configId, setConfigId] = useState<string | null>(null)

  // 所有报告 agent（type=report），按 cadence 日→周→月稳定排序，各渲染一张卡。
  const reportAgents = useMemo(() => {
    const order: Record<string, number> = { daily: 0, weekly: 1, monthly: 2 }
    return agents
      .filter((a) => a.type === 'report')
      .sort((a, b) => (order[a.schedule?.cadence] ?? 9) - (order[b.schedule?.cadence] ?? 9))
  }, [agents])
  const configAgent = useMemo(
    () => reportAgents.find((a) => a.id === configId) ?? null,
    [reportAgents, configId]
  )

  // 三层各司其职：①外层 relative 不滚 → drawer 钉这层（不随列表滚）②滚动层 absolute inset:0
  // 承接滚动、**block 流非 flex**（子项自然高度、超出滚动，绝不压缩卡片）③内容层 flex column
  // 仅排列 + gap。drawer 打开时滚动层切 overflow:hidden → 列表锁定（不滚 + 隐藏滚动条）。
  return (
    <div style={{ position: 'relative', flex: 1, height: '100%' }}>
      {/* 滚动层 absolute 脱流，外层须有明确高度（height:100%，依赖 main 的确定高度）撑起，
          否则 absolute inset:0 塌成 0 → 整页只剩背景。 */}
      <div
        className="scrollbar-thin"
        style={{ position: 'absolute', inset: 0, overflowY: configAgent ? 'hidden' : 'auto' }}
      >
        {/* 内容层自然高度（不设 height）—— 卡片始终自然高度，agent 再多也只是列表变长后滚动。
            全宽（不限宽）：内容靠 28px 侧 padding 撑满 main，与报告/Chats 同 full-bleed。 */}
        <div
          style={{
            padding: '22px 28px 60px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: 'rgb(var(--ink-fg))',
                letterSpacing: '-0.01em'
              }}
            >
              {t('agents.title')}
            </h1>
            <p style={{ fontSize: 13.5, color: 'rgb(var(--ink-fg-2))', marginTop: 5 }}>
              {t('agents.subtitle')}
            </p>
          </div>
          {reportAgents.length > 0 ? (
            reportAgents.map((cfg) => (
              <AgentCard
                key={cfg.id}
                cfg={cfg}
                onConfig={() => setConfigId(cfg.id)}
                onOpenReports={onOpenReports}
              />
            ))
          ) : (
            <div
              style={{
                borderRadius: 14,
                border: '1px solid rgb(var(--ink-border))',
                padding: '22px 20px',
                fontSize: 13,
                color: 'rgb(var(--ink-fg-3))'
              }}
            >
              {isLoading ? t('agents.reports.loading') : t('agents.card.noAgent')}
            </div>
          )}
          <NewAgentTile />
        </div>
      </div>
      {/* 始终挂载，由 open 驱动进/退场动画（退场播完才卸载，见 useExitAnimation）。 */}
      <ConfigDrawer
        cfg={configAgent}
        open={configAgent !== null}
        onClose={() => setConfigId(null)}
      />
    </div>
  )
}
