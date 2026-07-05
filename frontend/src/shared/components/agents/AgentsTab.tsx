// Sprint 20 — Agents tab：邮件日报 agent 概览卡（启用/运行/配置 + 最近报告）+
// 配置 slide-over（prompt / 排程 / 触发模式 / 带正文优先级 / 模型 / KOS 增强）+ 新建占位。
// 移植自 ~/Downloads/agents/agents-tab.jsx，接 report:getConfig/setConfig/runNow。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportCadence,
  ReportConfigPatch
} from '@shared/api/types'
import { DEFAULT_SEARCH_AGENT_PROMPT } from '@shared/assistant/searchAgentClient'
import { CadencePill, ReportIcon, StatusBadge, Switch } from './primitives'
import { CustomAgentDrawer, RunStateBadge } from './CustomAgentDrawer'
import { AgentPendingCountBadge, PendingDot } from './AgentPendingBadge'
import {
  useAgentPendingCount,
  useAgentRuns,
  useCreateAgent,
  useCustomAgentsEnabled,
  useDeleteAgent,
  useKosAvailable,
  useReportConfig,
  useReportList,
  useRunNow,
  useSetConfig
} from './hooks'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useMailApi } from '@shared/hooks/useMailApi'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
// v27 「AI 邮件预处理」配置抽屉内联复用身份文档正文编辑器（同组件不同入口）。
import { StandingDocsSection } from '@shared/components/settings/CustomAiSection'

// 内联按钮缺 :active 伪类 → 用 pointer 事件落地 press scale（DESIGN §9.3 / make-interfaces #12）。
// scale 0.97 ≥ 0.95 红线；调用方须在 style 里把 transform 列进 transition（含 transform，禁 transition:all）。
const PRESS_SCALE = 'scale(0.97)'
function pressHandlers(scale = PRESS_SCALE): {
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void
  onMouseUp: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void
} {
  return {
    onMouseDown: (e) => {
      e.currentTarget.style.transform = scale
    },
    onMouseUp: (e) => {
      e.currentTarget.style.transform = 'none'
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.transform = 'none'
    }
  }
}

const HOUR_OPTIONS = [6, 7, 8, 9, 10, 12, 18, 21]
// weekday：与后端 worker.py 一致，Python datetime.weekday() 口径 0=周一 … 6=周日。
const WEEKDAY_OPTIONS = [0, 1, 2, 3, 4, 5, 6]
// day_of_month：后端 worker 用 now.day 精确匹配、无月末回退 → 限 1–28，保证每月都触发。
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1)
// 顺序固定，与 src/llm_agent/schema.py PRIORITY_ENUM 对齐 —— 勾选的优先级邮件带完整正文。
const PRIORITY_ENUM = ['🔴 紧急', '🟡 重要', '🟢 一般', '⚪ 低'] as const

// v27 「AI 邮件预处理」agent —— 后端 DB v27 播种单行（id 固定、type='preprocess'）。
// 双源绑定：启用/模型走全局 env（LLM_AGENT_ENABLED / LLM_MODEL，pydantic singleton→需重启
// 生效，与 AiTab 现有 toggle 一致）；persona + 文档勾选存 report_agent row（prompt / context_docs）。
const PREPROCESS_AGENT_ID = 'email_preprocess_agent'
// 可注入分类 system prompt 的身份文档（profile-doc 名）；后端默认播种 ['soul','user']。
const PREPROCESS_DOCS = ['soul', 'agent', 'rules', 'user'] as const

// S5 W5a 「项目周报同步」专型行 —— 后端 DB v31 播种单行（id 固定、type='project_progress'）。
// 触发（enabled + sender/subject）存 report_agent row（enabled 列 + trigger_json，Settings 改即
// 生效）；总闸走全局 env PROJECT_PROGRESS_SYNC_ENABLED（.env，非 UI toggle）；执行走确定性 runner
// （xlsx→Notion），不进 gateway。
const PROJECT_PROGRESS_AGENT_ID = 'project_progress_sync'

// 远程 web 下 env 写只读（镜像 AiTab.isWeb）：env:set 在 HttpApi 是 notImplemented，
// 故启用/模型控件禁用；persona / 文档勾选 / 身份文档编辑走 HTTP row/profile 端点，仍可编辑。
const IS_WEB =
  (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
  'web'

// LLM_AGENT_ENABLED 存的是 'true'/'1' 视作开（镜像 EnvField toggle 解析）。
function envFlagOn(raw: string): boolean {
  return raw === 'true' || raw === '1'
}

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
        // 主题 v2 round 5 — 卡片实底转半透 (玻璃下死色块)。
        background: 'rgb(var(--ink-2) / 0.55)',
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
              background: 'rgb(var(--ink-1) / 0.5)',
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
            border: 0,
            transition:
              'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
          }}
          onMouseEnter={(e) => {
            if (!isRunning) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
          }}
          onMouseDown={(e) => {
            if (!isRunning) e.currentTarget.style.transform = PRESS_SCALE
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.transform = 'none'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
            e.currentTarget.style.transform = 'none'
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
            border: '1px solid rgb(var(--ink-border))',
            transition:
              'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgb(var(--ink-4))')}
          onMouseDown={(e) => (e.currentTarget.style.transform = PRESS_SCALE)}
          onMouseUp={(e) => (e.currentTarget.style.transform = 'none')}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.transform = 'none'
          }}
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

// 「Custom Agent」入口。S5：`MAILAGENT_CUSTOM_AGENTS_ENABLED` 开启（enabled=true）→ 可点
// 开新建 CustomAgentDrawer；flag off / 缺失 → 保持 coming-soon 禁用占位（字节级同现状文案，
// 只在 enabled 分支加交互，disabled 分支不变）。
function NewAgentTile({
  enabled,
  onClick
}: {
  enabled: boolean
  onClick: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  if (!enabled) {
    return (
      <div
        className="flex items-center"
        aria-disabled="true"
        style={{
          width: '100%',
          borderRadius: 14,
          border: '1px dashed rgb(var(--ink-border))',
          padding: '22px 20px',
          gap: 13,
          cursor: 'default',
          background: 'transparent',
          opacity: 0.6
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
            background: 'rgb(var(--ink-2) / 0.6)',
            color: 'rgb(var(--ink-fg-3))'
          }}
        >
          <ReportIcon name="plus" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'rgb(var(--ink-fg-2))' }}>
            {t('agents.search.customAgentTitle')}
          </div>
          <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
            {t('agents.search.customAgentHint')}
          </div>
        </div>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center"
      style={{
        width: '100%',
        textAlign: 'left',
        borderRadius: 14,
        border: '1px dashed rgb(var(--c-accent) / 0.55)',
        padding: '22px 20px',
        gap: 13,
        cursor: 'pointer',
        background: 'transparent',
        fontFamily: 'inherit',
        transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
      }}
      {...pressHandlers()}
    >
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
        <ReportIcon name="plus" size={20} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {t('agents.custom.newTileTitle')}
        </div>
        <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
          {t('agents.custom.newTileHint')}
        </div>
      </div>
    </button>
  )
}

// ─── Custom Agent 卡（type='custom'）────────────────────────────────────────
// 精简卡：title / enabled / trigger 摘要 / 最近 run 状态徽标；点整卡开 CustomAgentDrawer。
function CustomAgentCard({
  cfg,
  onConfig
}: {
  cfg: ReportAgentConfig
  onConfig: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save } = useSetConfig()
  // 最近一次 run 的状态徽标（listRuns 读失败/无 run → 不显徽标）。
  const { runs } = useAgentRuns(cfg.id)
  const lastRun = runs[0] ?? null
  // 红点链 ②（P5）：该 agent 待审批（paused_pending）计数徽标（共享 pending-count 轮询，flag off →
  // 不轮询 → 恒 0 → 不渲染）。
  const customAgentsEnabled = useCustomAgentsEnabled()
  const pendingCount = useAgentPendingCount(customAgentsEnabled).byAgent[cfg.id] ?? 0
  const toggle = (v: boolean): void => {
    void save(cfg.id, { enabled: v })
  }

  const triggerSummary = ((): string => {
    const trig = cfg.trigger
    if (trig?.kind === 'cron') {
      return t('agents.custom.card.triggerCron', { cron: trig.cron, tz: trig.timezone || 'UTC' })
    }
    if (trig?.kind === 'email_filter') return t('agents.custom.card.triggerEmail')
    return t('agents.custom.card.triggerNone')
  })()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onConfig}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfig()
        }
      }}
      className="flex items-center"
      style={{
        width: '100%',
        textAlign: 'left',
        gap: 13,
        padding: '16px 20px',
        borderRadius: 14,
        cursor: 'pointer',
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))'
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
          background: 'rgb(var(--c-accent) / 0.14)',
          border: '1px solid rgb(var(--c-accent) / 0.30)',
          color: 'rgb(var(--c-accent))'
        }}
      >
        <ReportIcon name="cog" size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 9 }}>
          <h3
            style={{
              fontSize: 15.5,
              fontWeight: 600,
              color: 'rgb(var(--ink-fg))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {cfg.title}
          </h3>
          {lastRun && <RunStateBadge state={lastRun.state} />}
          <AgentPendingCountBadge count={pendingCount} />
        </div>
        <div style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-3))', marginTop: 3 }}>
          {triggerSummary}
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Switch on={cfg.enabled} onChange={toggle} />
      </div>
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
    setContextDocs(cfg.context_docs ?? [])
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
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px'
  }

  const onSave = (): void => {
    if (!cfg) return
    const patch: ReportConfigPatch = {
      enabled,
      // prompt 未改且仍是默认态 → 传 null 保持"用默认"；改过 → 传文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      kos_enrich: kosEnrich,
      context_docs: contextDocs,
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
          // 主题 v2 round 5 — 抽屉是真浮层: glass-base 高遮挡配方 (与窗口
          // tint 同源), 不再用 ink 实底。
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
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
                            background: on
                              ? 'rgb(var(--c-accent) / 0.14)'
                              : 'rgb(var(--ink-1) / 0.5)',
                            border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                            transition:
                              'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
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
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                {/* z-[70]: 本抽屉 (ConfigDrawer) backdrop/panel 是 z-60/61，高于 Radix
                    Select content 默认的 z-50 (popover 约定层，仅够 clear z-40 的 Settings
                    Dialog)。不抬高 → 下拉 portal 到 body 后落在抽屉之下被 glass 面板挡住，
                    表现为「点不开/无法切换」。70 介于抽屉(61)与 lightbox(100)之间。 */}
                <SelectContent className="z-[70]">
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
              border: 0,
              transition:
                'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
            }}
            onMouseEnter={(e) => {
              if (!isSaving) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
            }}
            onMouseDown={(e) => {
              if (!isSaving) e.currentTarget.style.transform = PRESS_SCALE
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'none'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
              e.currentTarget.style.transform = 'none'
            }}
          >
            {t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

// ─── Search Agent 卡 ─────────────────────────────────────────────────────────
// F4b — agentic 搜索 agent（type='search'）的概览卡。比 report 卡精简：只展示
// name / enabled / model（无排程 / 报告链接），点整卡开 SearchConfigDrawer。
function SearchAgentCard({
  cfg,
  onConfig
}: {
  cfg: ReportAgentConfig
  onConfig: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save } = useSetConfig()
  const toggle = (v: boolean): void => {
    void save(cfg.id, { enabled: v })
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onConfig}
      onKeyDown={(e) => {
        // 只响应卡片本身的键盘激活；焦点在内嵌 Switch 上的 Enter/Space 由 Switch
        // 处理，不应冒泡触发开抽屉。
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfig()
        }
      }}
      className="flex items-center"
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        gap: 13,
        padding: '18px 20px',
        borderRadius: 14,
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))',
        transition: 'border-color 120ms'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--c-accent) / 0.5)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--ink-border))')}
    >
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
        <ReportIcon name="search" size={20} />
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
          style={{
            marginTop: 4,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11.5,
            color: 'rgb(var(--ink-fg-2))'
          }}
        >
          {cfg.model || t('agents.config.model')}
        </div>
      </div>
      {/* 外层卡是 div role=button（非 <button>），故内嵌 Switch 的 role=switch button
          合法（HTML 不允许 button>button — 早期用 <button> 卡套 Switch 会触发
          hydration error）；span stopPropagation 防止点开关连带触发卡片 onConfig（开抽屉）。 */}
      <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
        <Switch on={cfg.enabled} onChange={toggle} />
      </span>
    </div>
  )
}

// ─── Search Agent 配置抽屉 ───────────────────────────────────────────────────
// F4b — 复刻 ConfigDrawer 三段式脚手架，但字段精简为 search agent 所需：
// enabled / title / model / prompt / tools。编辑既有走 useSetConfig；新建（cfg=null
// + create=true）走 useCreateAgent；footer 删除走 useDeleteAgent（两步确认）。
// 不改 report 的 ConfigDrawer。
const SEARCH_TOOLS = ['email_search_fulltext'] as const

// title → 稳定 slug，用于新建 agent id。保留 CJK + 字母 + 数字（中文产品常见全中文标题），
// latin 转小写，其余分隔符折成 `_`。仅真正为空时才时间戳兜底。
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return slug || `search_${Date.now().toString(36)}`
}

export function SearchConfigDrawer({
  cfg,
  open,
  create = false,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  /** true = 新建空态（cfg 为 null）；false = 编辑既有 cfg。 */
  create?: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { create: createAgent, isCreating } = useCreateAgent()
  const { remove, isDeleting } = useDeleteAgent()

  // 进/退场动效：与 ConfigDrawer 同款（遮罩淡入 + 抽屉右滑同步）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  const [enabled, setEnabled] = useState(true)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>('')
  // 选中的工具集合（MVP 只有 email_search_fulltext）。
  const [tools, setTools] = useState<string[]>([...SEARCH_TOOLS])
  const [errKey, setErrKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。依赖 [open, cfg, create]。同 ConfigDrawer 既有
  // 豁免理由：模态打开按 cfg/空态预填多字段表单，React Compiler 迁移债（真重构需父组件 key
  // 重置 remount + 预填搬 useState initializer，等价性风险高于收益），effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErrKey(null)
    setConfirming(false)
    if (create || !cfg) {
      setEnabled(true)
      setTitle('')
      // 回显内置默认搜索 prompt 供查看/覆写；promptDirty 仍 false → 未改时 onSave 存
      // null 走默认，不把默认快照写死进库（将来内置默认改了，此 agent 仍跟随）。
      setPrompt(DEFAULT_SEARCH_AGENT_PROMPT)
      setPromptDirty(false)
      setModel('')
      setTools([...SEARCH_TOOLS])
      return
    }
    setEnabled(cfg.enabled)
    setTitle(cfg.title)
    // prompt_is_default 的行后端返回空串 → 回显内置默认供查看/覆写；已自定义则回显自定义。
    setPrompt(cfg.prompt_is_default ? DEFAULT_SEARCH_AGENT_PROMPT : cfg.prompt)
    setPromptDirty(false)
    setModel(cfg.model || '')
    setTools(cfg.tools_json?.length ? cfg.tools_json : [...SEARCH_TOOLS])
  }, [open, cfg, create])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!shouldRender) return null

  const busy = isSaving || isCreating || isDeleting

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

  const toggleTool = (tool: string): void => {
    setTools((prev) => (prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]))
  }

  const onSave = (): void => {
    setErrKey(null)
    if (create) {
      const id = slugifyTitle(title)
      void createAgent({
        id,
        type: 'search',
        title: title.trim() || id,
        enabled,
        model: model || null,
        // prompt 已回显内置默认；未改（promptDirty=false）→ null 走默认不写死快照，改过 → 存文本。
        prompt: promptDirty ? prompt : null,
        tools
      })
        .then(onClose)
        .catch((e: unknown) => {
          // 真实 Electron 路径错误码挂在 err.code（message 是人话不含码串）。
          const code = (e as { code?: string })?.code
          setErrKey(code === 'E_INVALID_ARG' ? 'errConflict' : 'errGeneric')
        })
      return
    }
    if (!cfg) return
    const patch: ReportConfigPatch = {
      enabled,
      title: title.trim() || cfg.title,
      // prompt 未改且仍是默认态 → null 保持「用默认」；改过 → 文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      tools
    }
    void save(cfg.id, patch)
      .then(onClose)
      .catch((e: unknown) => {
        console.warn('search agent save failed', e)
        setErrKey('errGeneric')
      })
  }

  const onDelete = (): void => {
    if (!cfg) return
    setErrKey(null)
    void remove(cfg.id)
      .then(onClose)
      .catch((e: unknown) => {
        console.warn('search agent delete failed', e)
        setErrKey('errGeneric')
      })
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
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
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
            <ReportIcon name="search" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {create ? t('agents.search.newTitle') : t('agents.search.configTitle', { title })}
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
                background: 'rgb(var(--ink-2) / 0.55)',
                border: '1px solid rgb(var(--ink-border))'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                  {t('agents.config.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.search.sectionHint')}
                </div>
              </div>
              <Switch on={enabled} onChange={setEnabled} />
            </div>

            {/* title */}
            <Field label={t('agents.search.titleLabel')}>
              <input
                type="text"
                value={title}
                placeholder={t('agents.search.titlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
                style={inputStyle}
              />
            </Field>

            {/* prompt */}
            <Field label={t('agents.search.promptLabel')} hint={t('agents.search.promptHint')}>
              <textarea
                value={prompt}
                placeholder={t('agents.search.promptPlaceholder')}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptDirty(true)
                }}
                rows={9}
                className="scrollbar-thin"
                style={{
                  ...inputStyle,
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontSize: 13,
                  minHeight: 160
                }}
              />
            </Field>

            {/* model（抄 ConfigDrawer 的 enabledModels + orphan 兜底） */}
            <Field label={t('agents.config.model')}>
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
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

            {/* tools — MVP 只有 email_search_fulltext，多选 chip（存 patch.tools） */}
            <Field label={t('agents.search.tools')} hint={t('agents.search.toolsHint')}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                {SEARCH_TOOLS.map((tool) => {
                  const on = tools.includes(tool)
                  return (
                    <button
                      key={tool}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTool(tool)}
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
                      {t(`agents.search.tool.${tool}`)}
                    </button>
                  )
                })}
              </div>
            </Field>

            {errKey && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'rgb(var(--c-fail))',
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--c-fail) / 0.10)',
                  border: '1px solid rgb(var(--c-fail) / 0.25)'
                }}
              >
                {t(`agents.search.${errKey}`)}
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
            flexShrink: 0
          }}
        >
          {/* 删除：仅编辑既有时显示；两步确认（同 ReportsTab/SessionsPage 风格）。 */}
          {!create &&
            cfg &&
            (confirming ? (
              <span className="flex items-center" style={{ gap: 6 }}>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={busy}
                  className="flex items-center"
                  style={{
                    gap: 6,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    padding: '7px 12px',
                    borderRadius: 8,
                    cursor: busy ? 'wait' : 'pointer',
                    color: 'rgb(var(--c-fail))',
                    background: 'rgb(var(--c-fail) / 0.12)',
                    border: '1px solid rgb(var(--c-fail) / 0.3)',
                    transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
                  }}
                  {...pressHandlers()}
                >
                  {t('agents.search.deleteConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="btn-ghost"
                  style={{ fontFamily: 'inherit' }}
                >
                  {t('agents.search.deleteCancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex items-center"
                style={{
                  gap: 6,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'transparent',
                  border: '1px solid rgb(var(--c-fail) / 0.3)',
                  transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
                }}
                {...pressHandlers()}
              >
                <ReportIcon name="x" size={14} />
                {t('agents.search.delete')}
              </button>
            ))}
          <span style={{ flex: 1 }} />
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
            disabled={busy}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: busy ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0,
              transition:
                'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
            }}
            onMouseDown={(e) => {
              if (!busy) e.currentTarget.style.transform = PRESS_SCALE
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'none'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
              e.currentTarget.style.transform = 'none'
            }}
          >
            {create ? t('agents.search.create') : t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

// ─── AI 邮件预处理卡（type='preprocess'）──────────────────────────────────────
// 后端 DB v27 播种单行，无新建 / 删除。启用态从 env LLM_AGENT_ENABLED 读（非 row.enabled
// —— 行的 enabled 列对预处理无意义，开关绑全局 LLM agent 总开关）。persona / 文档勾选 /
// 身份文档正文全部在配置抽屉里编辑。#7 dogfood：右侧快捷开关，env 未就绪或 web 时禁用。
// v1.3.0 dogfood：整卡可点开抽屉（照 SearchAgentCard 模式），删独立配置按钮。
function PreprocessAgentCard({
  cfg,
  enabled,
  envReady,
  onConfig,
  onToggle
}: {
  cfg: ReportAgentConfig
  enabled: boolean
  /** env store 是否就绪；未就绪时禁用开关防止误写 */
  envReady: boolean
  onConfig: () => void
  /** 快捷开关回调；web / env 未就绪时不传（禁用） */
  onToggle?: (v: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onConfig}
      onKeyDown={(e) => {
        // 只响应卡片本身的键盘激活；焦点在内嵌 Switch 上的 Enter/Space 由 Switch
        // 处理，不应冒泡触发开抽屉。
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfig()
        }
      }}
      className="flex items-center"
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        gap: 13,
        padding: '18px 20px',
        borderRadius: 14,
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))',
        transition: 'border-color 120ms'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--c-accent) / 0.5)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--ink-border))')}
    >
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
        <ReportIcon name="zap" size={20} />
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
              color: enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))',
              background: enabled ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--ink-fg) / 0.05)',
              border: `1px solid ${enabled ? 'rgb(var(--c-ok) / 0.25)' : 'rgb(var(--ink-border))'}`
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))'
              }}
            />
            {enabled ? t('agents.card.enabled') : t('agents.card.disabled')}
          </span>
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-2))',
            lineHeight: 1.5
          }}
        >
          {t('agents.preprocess.subtitle')}
        </div>
      </div>
      {/* #7 dogfood：快捷开关，env 未就绪 / web 时禁用（镜像抽屉的启用行语义）。
          span stopPropagation 防止点开关连带触发卡片 onConfig（同 SearchAgentCard）。 */}
      <span
        onClick={(e) => e.stopPropagation()}
        style={
          !envReady || IS_WEB || !onToggle
            ? { opacity: 0.5, pointerEvents: 'none', display: 'flex', flexShrink: 0 }
            : { display: 'flex', flexShrink: 0 }
        }
      >
        <Switch on={enabled} onChange={onToggle ?? (() => {})} />
      </span>
    </div>
  )
}

// ─── AI 邮件预处理配置抽屉 ────────────────────────────────────────────────────
// 复刻 SearchConfigDrawer 三段式脚手架。双源写：启用 → 全局 env（applyEnvPatch + 重启横幅，
// pydantic singleton 需重启）；模型 / fallback / 文档勾选 → report_agent row（useSetConfig；
// #8-ext 模型走行级 model 列、空 = 跟随全局 LLM_MODEL；R2 #2 fallback 走行级
// fallback_models_json 列、NULL = 跟随全局 LLM_FALLBACK_MODELS —— 均与全局设置拆分，改行级
// 值保存即生效无需重启）；身份文档正文内联复用 StandingDocsSection。
// persona 输入已随 v1.1.0 dogfood 移除（身份/偏好由 Standing Context 文档注入）；分类
// prompt（收件箱/发件箱 .md）v1.3.0 dogfood 起在抽屉内可直接编辑（mailApi.prompts
// read/write：桌面走 prompts IPC、远程 web 走 GET/PUT /api/prompts/{slot}；文件仍是
// SSoT，PromptLoader mtime 热加载 —— 保存即生效无需重启）。

/** 模型下拉「跟随全局默认」哨兵（radix SelectItem 禁空串 value）。 */
const FOLLOW_GLOBAL_MODEL = '__follow_global__'
/** fallback 下拉「跟随全局」哨兵（R2 #2：行级列 NULL；同上 radix 禁空串 value）。 */
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
/** fallback 下拉「不设」哨兵（行级列 '[]'；同上，空串 value 会让 radix 直接 throw）。 */
const FALLBACK_NONE = '__none__'

/** 分类 prompt 每 slot 的编辑草稿（content 可编辑；path 用于次要信息展示）。 */
interface PromptDraft {
  content: string
  path: string
  dirty: boolean
}
type PromptDrafts = Record<'inbox' | 'sent', PromptDraft>

function PreprocessConfigDrawer({
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
  // 分类 prompt 读写走 mailApi.prompts（桌面 IPC / web PUT /api/prompts/{slot}）。
  const api = useMailApi()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // 进 / 退场动效：与 ConfigDrawer / SearchConfigDrawer 同款（遮罩淡入 + 抽屉右滑同步）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  // 启用 = env 值本地镜像（**dirty 追踪**：仅用户显式改过的字段在保存时写回 env →
  // 未触碰的字段永不写，即使预填时 env 未就绪 idle 也不会把真实 .env 覆写掉，codex HIGH）；
  // 模型 / fallback / 文档勾选 = row 值（#8-ext 模型空串 = 跟随全局 LLM_MODEL；R2 #2
  // fallback 存哨兵或模型 id，对应行级列 NULL / '[]' / '[m]'，PATCH 保存无需重启）。
  const [enabled, setEnabled] = useState(false)
  const [enabledDirty, setEnabledDirty] = useState(false)
  const [model, setModel] = useState<string>('')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(FALLBACK_FOLLOW_GLOBAL)
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [contextDocs, setContextDocs] = useState<string[]>([])
  const [envSaving, setEnvSaving] = useState(false)
  // 分类 prompt 编辑草稿（收件箱/发件箱 tab，textarea 可编辑，保存写回 .md 文件）——
  // 打开抽屉时经 mailApi.prompts.read 拉两份。
  const [promptDrafts, setPromptDrafts] = useState<PromptDrafts | 'loading' | 'error'>('loading')
  const [promptTab, setPromptTab] = useState<'inbox' | 'sent'>('inbox')
  const { models: enabledModels } = useEnabledModels()
  // env store 状态（idle/loading 时 enable 不可编辑、保存不写 env）+ 响应式 env 值
  // （就绪后回填，仅在用户未触碰该字段时）。envModelRaw / envFallbackRaw 仅用于
  // 「跟随全局」选项的当前值展示（R2 #2：fallback 已改行级列，env 值不再回填进编辑态）。
  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const envEnabledRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_AGENT_ENABLED'] ?? '') : null
  )
  const envModelRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_MODEL'] ?? '') : null
  )
  const envFallbackRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_FALLBACK_MODELS'] ?? '') : null
  )

  // 打开时预填 row 字段 + 复位所有 dirty。同 ConfigDrawer / SearchConfigDrawer 既有豁免理由：
  // 模态打开按 cfg 预填多字段表单，React Compiler 迁移债（真重构需父组件 key 重置 remount +
  // 预填搬 useState initializer，等价性风险高于收益），effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setModel(cfg.model ?? '')
    // R2 #2 行级 fallback：null → 跟随全局哨兵、[] → 不设哨兵、[m,...] → 首个 m
    // （UI 单选，保存也只存单模型链 [m]）。
    setFallbackModel(
      cfg.fallback_models == null
        ? FALLBACK_FOLLOW_GLOBAL
        : cfg.fallback_models.length === 0
          ? FALLBACK_NONE
          : cfg.fallback_models[0]
    )
    setContextDocs(cfg.context_docs ?? [])
    setEnabledDirty(false)
    setModelDirty(false)
    setFallbackModelDirty(false)
    setPromptTab('inbox')
  }, [open, cfg])
  // 启用从 env 就绪快照回填：仅在打开且用户未 dirty 该字段时同步 —— env idle→ready 的
  // 迟到加载能纠正显示，但绝不覆盖用户在抽屉里的编辑（dirty 后停止同步）。
  useEffect(() => {
    if (!open) return
    if (envEnabledRaw !== null && !enabledDirty) setEnabled(envFlagOn(envEnabledRaw))
  }, [open, envEnabledRaw, enabledDirty])
  // 分类 prompt：打开时经 mailApi.prompts.read 拉两份（best-effort，失败显示占位；
  // 关闭时丢弃避免 setState-after-close）。与运行时 PromptLoader 同两份文件（mtime 热加载）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPromptDrafts('loading')
    void Promise.all([api.prompts.read('inbox'), api.prompts.read('sent')])
      .then(([inbox, sent]) => {
        if (cancelled) return
        setPromptDrafts({
          inbox: { content: inbox.content, path: inbox.path, dirty: false },
          sent: { content: sent.content, path: sent.path, dirty: false }
        })
      })
      .catch(() => {
        if (!cancelled) setPromptDrafts('error')
      })
    return () => {
      cancelled = true
    }
  }, [open, api.prompts])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!shouldRender) return null

  const busy = isSaving || envSaving

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

  const onSave = async (): Promise<void> => {
    if (!cfg) return
    // 1) env 写：仅在 env 已就绪、非 web、且用户显式改过该字段（dirty）时写 —— 未触碰的
    //    enable 永不写，即使预填 stale（env idle）也不会把真实 .env 覆写掉（codex HIGH）。
    //    只写变更键，避免无谓触发重启横幅。（#8-ext 模型 / R2 #2 fallback 均不再写 env ——
    //    走 row PATCH。）
    if (envReady && !IS_WEB) {
      const st = useEnvStore.getState().state
      const vals = st.status === 'ready' ? st.snapshot.values : {}
      const envPatch: Record<string, string> = {}
      const nextEnabled = enabled ? 'true' : 'false'
      if (enabledDirty && nextEnabled !== (vals['LLM_AGENT_ENABLED'] ?? '')) {
        envPatch['LLM_AGENT_ENABLED'] = nextEnabled
      }
      if (Object.keys(envPatch).length > 0) {
        setEnvSaving(true)
        try {
          const r = await applyEnvPatch(envPatch)
          if (!r.ok) {
            toastError(t('agents.preprocess.envSaveError'), `${r.error.code}: ${r.error.message}`)
            return
          }
          // 与 EnvField 一致：变更键挂重启横幅（LLM_AGENT_ENABLED 是 pydantic singleton）。
          if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
        } finally {
          setEnvSaving(false)
        }
      }
    }
    // 2) 分类 prompt 写：仅 dirty 的 slot 写回 .md 文件（桌面走 prompts IPC、web 走
    //    PUT /api/prompts/{slot}）。PromptLoader 按 mtime 热加载 —— 保存即生效无需重启。
    if (promptDrafts !== 'loading' && promptDrafts !== 'error') {
      let wrotePrompt = false
      for (const slot of ['inbox', 'sent'] as const) {
        const draft = promptDrafts[slot]
        if (!draft.dirty) continue
        const r = await api.prompts.write(slot, draft.content)
        if (!r.ok) {
          toastError(t('agents.preprocess.promptSaveError'), `${r.code}: ${r.message}`)
          return
        }
        wrotePrompt = true
      }
      if (wrotePrompt) toastSuccess(t('agents.preprocess.promptSaved'))
    }
    // 3) row 保存：模型（#8-ext 行级 model 列；空串 = 跟随全局 LLM_MODEL，config_patch_to_db
    //    原样落列、resolve_agent 非 report 不回填默认）+ fallback（R2 #2 行级列；null =
    //    重置回跟随全局、[] = 显式不设、[m] = 单模型链）+ 文档勾选。改行级值立即生效
    //    （分类每封邮件重读 preprocess 行），无需重启。
    try {
      await save(PREPROCESS_AGENT_ID, {
        ...(modelDirty ? { model } : {}),
        ...(fallbackModelDirty
          ? {
              fallback_models:
                fallbackModel === FALLBACK_FOLLOW_GLOBAL
                  ? null
                  : fallbackModel === FALLBACK_NONE
                    ? []
                    : [fallbackModel]
            }
          : {}),
        context_docs: contextDocs
      })
      onClose()
    } catch (e: unknown) {
      toastError(t('agents.preprocess.rowSaveError'), (e as Error).message)
    }
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
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
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
            <ReportIcon name="zap" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {t('agents.preprocess.configTitle', { title: cfg?.title ?? '' })}
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
            {/* 远程 web 只读提示（env 写不可用；persona / 文档仍可改） */}
            {IS_WEB && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'rgb(var(--ink-fg-2))',
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--ink-1) / 0.5)',
                  border: '1px solid rgb(var(--ink-border-soft))'
                }}
              >
                {t('agents.preprocess.webReadOnly')}
              </div>
            )}

            {/* 启用（env LLM_AGENT_ENABLED）—— 需重启生效 */}
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
                  {t('agents.preprocess.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.preprocess.enableHint')}
                </div>
              </div>
              <span
                style={!envReady || IS_WEB ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              >
                <Switch
                  on={enabled}
                  onChange={(v) => {
                    setEnabled(v)
                    setEnabledDirty(true)
                  }}
                />
              </span>
            </div>

            {/* 模型（row.model，PATCH 保存立即生效）—— #8-ext：与 chat 的全局默认（LLM_MODEL）
                拆分；「跟随全局」哨兵 = 行级空串。enabledModels + orphan 兜底同 ConfigDrawer。 */}
            <Field label={t('agents.config.model')} hint={t('agents.preprocess.modelHint')}>
              <Select
                value={model || FOLLOW_GLOBAL_MODEL}
                onValueChange={(v) => {
                  setModel(v === FOLLOW_GLOBAL_MODEL ? '' : v)
                  setModelDirty(true)
                }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value={FOLLOW_GLOBAL_MODEL}>
                    {t('agents.preprocess.modelFollowGlobal', {
                      model: envModelRaw || 'claude-sonnet-4-6'
                    })}
                  </SelectItem>
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

            {/* fallback 模型（row.fallback_models_json，R2 #2 行级，PATCH 保存立即生效）——
                主模型失败时兜底。「跟随全局」哨兵 = 行 NULL（用全局 LLM_FALLBACK_MODELS）、
                「不设」哨兵 = 行 '[]'（显式无兜底）。 */}
            <Field
              label={t('agents.preprocess.fallback')}
              hint={t('agents.preprocess.fallbackHint')}
            >
              <Select
                value={fallbackModel}
                onValueChange={(v) => {
                  setFallbackModel(v)
                  setFallbackModelDirty(true)
                }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value={FALLBACK_FOLLOW_GLOBAL}>
                    {t('agents.preprocess.fallbackFollowGlobal', {
                      model: envFallbackRaw || t('agents.preprocess.fallbackGlobalUnset')
                    })}
                  </SelectItem>
                  <SelectItem value={FALLBACK_NONE}>
                    {t('agents.preprocess.fallbackNone')}
                  </SelectItem>
                  {(fallbackModel !== FALLBACK_FOLLOW_GLOBAL &&
                  fallbackModel !== FALLBACK_NONE &&
                  !enabledModels.includes(fallbackModel)
                    ? [...enabledModels, fallbackModel]
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

            {/* 分类 prompt 编辑（v1.3.0 dogfood：只读 → 可编辑）—— 收件箱/发件箱 .md 与
                运行时同源（PromptLoader mtime 热加载同两份文件），保存即生效无需重启。
                persona 输入已移除：身份/偏好由上方勾选的 Standing Context 文档注入。 */}
            <Field
              label={t('agents.preprocess.promptView')}
              hint={t('agents.preprocess.promptViewHint')}
            >
              <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
                {(['inbox', 'sent'] as const).map((tab) => {
                  const on = promptTab === tab
                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPromptTab(tab)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 8,
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        cursor: 'pointer',
                        color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                        background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                        border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                        transition:
                          'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
                      }}
                    >
                      {t(`agents.preprocess.promptTab.${tab}`)}
                    </button>
                  )
                })}
              </div>
              {promptDrafts === 'loading' ? (
                <div style={{ ...inputStyle, color: 'rgb(var(--ink-fg-3))' }}>…</div>
              ) : promptDrafts === 'error' ? (
                <div style={{ ...inputStyle, color: 'rgb(var(--ink-fg-3))' }}>
                  {t('agents.preprocess.promptLoadError')}
                </div>
              ) : (
                <>
                  <textarea
                    value={promptDrafts[promptTab].content}
                    onChange={(e) => {
                      const next = e.target.value
                      setPromptDrafts((prev) =>
                        prev === 'loading' || prev === 'error'
                          ? prev
                          : {
                              ...prev,
                              [promptTab]: { ...prev[promptTab], content: next, dirty: true }
                            }
                      )
                    }}
                    spellCheck={false}
                    placeholder={t('agents.preprocess.promptEmpty')}
                    className="scrollbar-thin"
                    style={{
                      ...inputStyle,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      minHeight: 220,
                      resize: 'vertical'
                    }}
                  />
                  {promptDrafts[promptTab].path && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'rgb(var(--ink-fg-3))',
                        marginTop: 6,
                        wordBreak: 'break-all'
                      }}
                    >
                      {promptDrafts[promptTab].path}
                    </div>
                  )}
                </>
              )}
            </Field>

            {/* 文档勾选（cfg.context_docs）—— 注入分类 system prompt 的身份文档 */}
            <Field
              label={t('agents.preprocess.contextDocs')}
              hint={t('agents.preprocess.contextDocsHint')}
            >
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
                {t('agents.preprocess.contextDocsNote')}
              </div>
            </Field>

            {/* 身份文档正文编辑：内联复用 Settings 的 StandingDocsSection（自渲染标题 + 自 flag 门控，
                flag-off / 未加载时返回 null，不留空占位）。 */}
            <StandingDocsSection />
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
            onClick={() => void onSave()}
            disabled={busy}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: busy ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0,
              transition:
                'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
            }}
            onMouseDown={(e) => {
              if (!busy) e.currentTarget.style.transform = PRESS_SCALE
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'none'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
              e.currentTarget.style.transform = 'none'
            }}
          >
            {t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

// ─── 项目周报同步卡（type='project_progress'，S5 W5a）────────────────────────
// 后端 DB v31 播种单行，无新建 / 删除。启用态 = row.enabled（Settings 抽屉 / 快捷开关改，
// 保存即生效）；但**总闸走 env PROJECT_PROGRESS_SYNC_ENABLED**（.env，非 UI）—— 总闸未开时
// 卡片显示「总闸未开」态，快捷开关禁用（防用户误以为能全 UI 开启）。
function ProjectProgressAgentCard({
  cfg,
  masterEnabled,
  onConfig,
  onToggle
}: {
  cfg: ReportAgentConfig
  /** env 总闸 PROJECT_PROGRESS_SYNC_ENABLED（.env）；off → 卡片「总闸未开」态。 */
  masterEnabled: boolean
  onConfig: () => void
  /** 快捷开关：切 row.enabled（总闸未开 / web 时禁用不传）。 */
  onToggle?: (v: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const rowEnabled = cfg.enabled
  // 徽标三态：总闸未开（中性）→ 总闸开且行启用（绿）→ 总闸开但行停用（灰）。
  const badgeLabel = !masterEnabled
    ? t('agents.projectProgress.masterOff')
    : rowEnabled
      ? t('agents.card.enabled')
      : t('agents.card.disabled')
  const badgeOn = masterEnabled && rowEnabled
  // v1.3.0 dogfood：整卡可点开抽屉（照 SearchAgentCard 模式），删独立配置按钮。
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onConfig}
      onKeyDown={(e) => {
        // 只响应卡片本身的键盘激活；焦点在内嵌 Switch 上的 Enter/Space 由 Switch
        // 处理，不应冒泡触发开抽屉。
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfig()
        }
      }}
      className="flex items-center"
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        gap: 13,
        padding: '18px 20px',
        borderRadius: 14,
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))',
        transition: 'border-color 120ms'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--c-accent) / 0.5)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--ink-border))')}
    >
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
        <ReportIcon name="barchart" size={20} />
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
              color: badgeOn ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))',
              background: badgeOn ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--ink-fg) / 0.05)',
              border: `1px solid ${badgeOn ? 'rgb(var(--c-ok) / 0.25)' : 'rgb(var(--ink-border))'}`
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: badgeOn ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))'
              }}
            />
            {badgeLabel}
          </span>
        </div>
        <div
          style={{ marginTop: 4, fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', lineHeight: 1.5 }}
        >
          {t('agents.projectProgress.subtitle')}
        </div>
      </div>
      {/* 快捷开关切 row.enabled；总闸未开 / web 时禁用（防误以为能全 UI 开启）。
          span stopPropagation 防止点开关连带触发卡片 onConfig（同 SearchAgentCard）。 */}
      <span
        onClick={(e) => e.stopPropagation()}
        style={
          !masterEnabled || IS_WEB || !onToggle
            ? { opacity: 0.5, pointerEvents: 'none', display: 'flex', flexShrink: 0 }
            : { display: 'flex', flexShrink: 0 }
        }
      >
        <Switch on={rowEnabled} onChange={onToggle ?? (() => {})} />
      </span>
    </div>
  )
}

// ─── 项目周报同步配置抽屉（S5 W5a）────────────────────────────────────────────
// 镜像 PreprocessConfigDrawer 单例编辑脚手架，双源写：
//   • row（enabled + trigger_json，保存即生效无需重启，走 useSetConfig）—— sender 是子串、
//     subject 是正则（后端 ProjectProgressDetector 语义；trigger_json 复用 email_filter
//     字段名）；保存时后端 parse_trigger 校验（空触发拒）。
//   • env（v1.3.0 dogfood 收编自 Settings→集成：总闸 PROJECT_PROGRESS_SYNC_ENABLED /
//     PROJECT_PROGRESS_DATABASE_ID / PROJECT_PROGRESS_FILTER_BU，applyEnvPatch + 重启横幅
//     —— 三者均为启动时一次性读取，改后需重启后端生效；dirty 追踪同 PreprocessConfigDrawer，
//     codex HIGH：未触碰的字段永不写回 .env）。
function ProjectProgressConfigDrawer({
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
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  const [enabled, setEnabled] = useState(false)
  const [sender, setSender] = useState('')
  const [subject, setSubject] = useState('')
  const [triggerDirty, setTriggerDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // env 三字段本地镜像（dirty 追踪；保存时只写显式改过且值变化的键）。
  const [master, setMaster] = useState(false)
  const [masterDirty, setMasterDirty] = useState(false)
  const [dbId, setDbId] = useState('')
  const [dbIdDirty, setDbIdDirty] = useState(false)
  const [filterBu, setFilterBu] = useState('')
  const [filterBuDirty, setFilterBuDirty] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)

  // env store 状态 + 响应式 env 原值（就绪后回填，仅在用户未触碰该字段时）。
  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const envMasterRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')
      : null
  )
  const envDbIdRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_DATABASE_ID'] ?? '')
      : null
  )
  const envFilterBuRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_FILTER_BU'] ?? '')
      : null
  )
  const masterEnabled = envMasterRaw !== null && envFlagOn(envMasterRaw)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setEnabled(cfg.enabled)
    const trig = cfg.trigger
    setSender(trig?.kind === 'email_filter' ? (trig.sender_pattern ?? '') : '')
    setSubject(trig?.kind === 'email_filter' ? (trig.subject_pattern ?? '') : '')
    setTriggerDirty(false)
    setMasterDirty(false)
    setDbIdDirty(false)
    setFilterBuDirty(false)
    setErr(null)
  }, [open, cfg])
  // env 字段从就绪快照回填：仅在打开且用户未 dirty 该字段时同步（镜像 PreprocessConfigDrawer
  // —— env idle→ready 的迟到加载能纠正显示，但绝不覆盖用户在抽屉里的编辑）。
  useEffect(() => {
    if (!open) return
    if (envMasterRaw !== null && !masterDirty) setMaster(envFlagOn(envMasterRaw))
  }, [open, envMasterRaw, masterDirty])
  useEffect(() => {
    if (!open) return
    if (envDbIdRaw !== null && !dbIdDirty) setDbId(envDbIdRaw)
  }, [open, envDbIdRaw, dbIdDirty])
  useEffect(() => {
    if (!open) return
    if (envFilterBuRaw !== null && !filterBuDirty) setFilterBu(envFilterBuRaw)
  }, [open, envFilterBuRaw, filterBuDirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!shouldRender) return null

  const busy = isSaving || envSaving

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

  const onSave = async (): Promise<void> => {
    if (!cfg) return
    // 触发若被改过则一并提交；改成空触发（sender+subject 全空）= 永不匹配的死配置，
    // 后端 parse_trigger 会拒 —— 前端先给友好错误（要停用请用启用开关）。
    const patch: ReportConfigPatch = { enabled }
    if (triggerDirty) {
      if (!sender.trim() && !subject.trim()) {
        setErr(t('agents.projectProgress.errEmptyTrigger'))
        return
      }
      const trig: CustomAgentTrigger = { v: 1, kind: 'email_filter' }
      if (sender.trim()) trig.sender_pattern = sender.trim()
      if (subject.trim()) trig.subject_pattern = subject.trim()
      patch.trigger = trig
    }
    setErr(null)
    // 1) env 写（总闸 / 项目库 ID / BU 过滤）：仅在 env 已就绪、非 web、且用户显式改过
    //    该字段（dirty）时写 —— 镜像 PreprocessConfigDrawer（codex HIGH：未触碰的字段
    //    永不写回 .env）。只写值变化的键，变更键挂重启横幅（三者均启动时一次性读取）。
    if (envReady && !IS_WEB) {
      const st = useEnvStore.getState().state
      const vals = st.status === 'ready' ? st.snapshot.values : {}
      const envPatch: Record<string, string> = {}
      const nextMaster = master ? 'true' : 'false'
      if (masterDirty && nextMaster !== (vals['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')) {
        envPatch['PROJECT_PROGRESS_SYNC_ENABLED'] = nextMaster
      }
      if (dbIdDirty && dbId.trim() !== (vals['PROJECT_PROGRESS_DATABASE_ID'] ?? '')) {
        envPatch['PROJECT_PROGRESS_DATABASE_ID'] = dbId.trim()
      }
      if (filterBuDirty && filterBu.trim() !== (vals['PROJECT_PROGRESS_FILTER_BU'] ?? '')) {
        envPatch['PROJECT_PROGRESS_FILTER_BU'] = filterBu.trim()
      }
      if (Object.keys(envPatch).length > 0) {
        setEnvSaving(true)
        try {
          const r = await applyEnvPatch(envPatch)
          if (!r.ok) {
            toastError(
              t('agents.projectProgress.envSaveError'),
              `${r.error.code}: ${r.error.message}`
            )
            return
          }
          if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
        } finally {
          setEnvSaving(false)
        }
      }
    }
    // 2) row 保存（enabled + trigger，保存即生效无需重启）。
    try {
      await save(PROJECT_PROGRESS_AGENT_ID, patch)
      onClose()
    } catch (e: unknown) {
      setErr((e as Error).message)
    }
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
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
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
            <ReportIcon name="barchart" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {t('agents.projectProgress.configTitle', { title: cfg?.title ?? '' })}
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
            {/* 远程 web 只读提示（env 写不可用；启用开关与触发规则仍可改） */}
            {IS_WEB && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'rgb(var(--ink-fg-2))',
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--ink-1) / 0.5)',
                  border: '1px solid rgb(var(--ink-border-soft))'
                }}
              >
                {t('agents.projectProgress.webReadOnly')}
              </div>
            )}

            {/* 总闸状态说明。总闸未开时高亮提示。 */}
            <div
              style={{
                fontSize: 12.5,
                color: masterEnabled
                  ? 'rgb(var(--ink-fg-2))'
                  : 'rgb(var(--c-warn, var(--ink-fg-1)))',
                padding: '10px 12px',
                borderRadius: 9,
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))',
                lineHeight: 1.55
              }}
            >
              {masterEnabled
                ? t('agents.projectProgress.masterOnNote')
                : t('agents.projectProgress.masterOffNote')}
            </div>

            {/* 总开关（env PROJECT_PROGRESS_SYNC_ENABLED，v1.3.0 收编自 Settings→集成）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
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
                  {t('agents.projectProgress.master')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.projectProgress.masterHint')}
                </div>
              </div>
              <span
                style={!envReady || IS_WEB ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              >
                <Switch
                  on={master}
                  onChange={(v) => {
                    setMaster(v)
                    setMasterDirty(true)
                  }}
                />
              </span>
            </div>

            {/* 启用（row.enabled，保存即生效） */}
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
                  {t('agents.projectProgress.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.projectProgress.enableHint')}
                </div>
              </div>
              <Switch on={enabled} onChange={setEnabled} />
            </div>

            {/* 触发：标题正则（必填）+ 发件人子串（可选，留空 = 任意发件人） */}
            <Field
              label={t('agents.projectProgress.subjectPattern')}
              hint={t('agents.projectProgress.subjectPatternHint')}
            >
              <input
                type="text"
                value={subject}
                placeholder={t('agents.projectProgress.subjectPlaceholder')}
                onChange={(e) => {
                  setSubject(e.target.value)
                  setTriggerDirty(true)
                }}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Field>
            <Field
              label={t('agents.projectProgress.senderPattern')}
              hint={t('agents.projectProgress.senderPatternHint')}
            >
              <input
                type="text"
                value={sender}
                placeholder={t('agents.projectProgress.senderPlaceholder')}
                onChange={(e) => {
                  setSender(e.target.value)
                  setTriggerDirty(true)
                }}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Field>

            {/* 项目进度库 ID（env PROJECT_PROGRESS_DATABASE_ID，v1.3.0 只读 → 可编辑）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
            <Field
              label={t('agents.projectProgress.database')}
              hint={t('agents.projectProgress.databaseHint')}
            >
              <input
                type="text"
                value={dbId}
                disabled={!envReady || IS_WEB}
                placeholder={t('agents.projectProgress.databaseUnset')}
                onChange={(e) => {
                  setDbId(e.target.value)
                  setDbIdDirty(true)
                }}
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--font-mono, monospace)',
                  ...(!envReady || IS_WEB ? { opacity: 0.5 } : {})
                }}
              />
            </Field>

            {/* BU 过滤（env PROJECT_PROGRESS_FILTER_BU，v1.3.0 收编自 Settings→集成）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
            <Field
              label={t('agents.projectProgress.filterBu')}
              hint={t('agents.projectProgress.filterBuHint')}
            >
              <input
                type="text"
                value={filterBu}
                disabled={!envReady || IS_WEB}
                placeholder={t('agents.projectProgress.filterBuPlaceholder')}
                onChange={(e) => {
                  setFilterBu(e.target.value)
                  setFilterBuDirty(true)
                }}
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--font-mono, monospace)',
                  ...(!envReady || IS_WEB ? { opacity: 0.5 } : {})
                }}
              />
            </Field>

            {/* 内置能力（R2(c)）：同步脚本 = 确定性 Python 直调、恒启用 —— 锁定态徽标，
                不可交互（不是 skill 体系，不能挂载/卸载）；唯一开关 = 上方启用开关。 */}
            <Field
              label={t('agents.projectProgress.capability')}
              hint={t('agents.projectProgress.capabilityHint')}
            >
              <span
                aria-disabled="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  cursor: 'default',
                  opacity: 0.7,
                  color: 'rgb(var(--c-accent))',
                  background: 'rgb(var(--c-accent) / 0.14)',
                  border: '1px solid rgb(var(--c-accent) / 0.5)'
                }}
              >
                <ReportIcon name="check" size={13} />
                {t('agents.projectProgress.capabilityChip')}
              </span>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 7,
                  lineHeight: 1.5
                }}
              >
                {t('agents.projectProgress.capabilityNote')}
              </div>
            </Field>

            {err && (
              <div style={{ fontSize: 12.5, color: 'rgb(var(--c-danger, var(--ink-fg-1)))' }}>
                {err}
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
            onClick={() => void onSave()}
            disabled={busy}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: busy ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0
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
  // F4b — search agent 配置抽屉：编辑既有(id) | 新建(create) | 关闭(null)。
  const [searchDrawer, setSearchDrawer] = useState<
    { mode: 'edit'; id: string } | { mode: 'create' } | null
  >(null)
  // S5 — custom agent 配置抽屉：编辑既有(id) | 新建(create) | 关闭(null)。
  const [customDrawer, setCustomDrawer] = useState<
    { mode: 'edit'; id: string } | { mode: 'create' } | null
  >(null)
  // S5 — MAILAGENT_CUSTOM_AGENTS_ENABLED（/chat/config 热读）；控 NewAgentTile 可点性。
  const customAgentsEnabled = useCustomAgentsEnabled()
  // 红点链 ③（P5）：Custom AI Agents 区 header dot（全局待审批 total>0）。flag off → 不轮询 → total 0。
  const customPendingTotal = useAgentPendingCount(customAgentsEnabled).total
  // v27 — AI 邮件预处理配置抽屉开合（后端播种单行，只编辑、无新建）。
  const [preprocessOpen, setPreprocessOpen] = useState(false)
  // S5 W5a — 项目周报同步配置抽屉开合（后端 v31 播种单行，只编辑、无新建）。
  const [projectProgressOpen, setProjectProgressOpen] = useState(false)
  // 项目周报卡的总闸绑 env PROJECT_PROGRESS_SYNC_ENABLED（响应式读，总闸未开 → 卡片显「总闸未开」）。
  const projectProgressMaster = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')
      : false
  )
  const { save: saveProgressRow } = useSetConfig()
  // 项目周报卡快捷开关：切 row.enabled（保存即生效，不写 env）。
  const handleProjectProgressToggle = async (v: boolean): Promise<void> => {
    try {
      await saveProgressRow(PROJECT_PROGRESS_AGENT_ID, { enabled: v })
    } catch (e: unknown) {
      toastError(t('agents.projectProgress.rowSaveError'), (e as Error).message)
    }
  }
  // 预处理卡的启用态绑全局 env LLM_AGENT_ENABLED（响应式读，env 变即刷新徽标）。
  const llmAgentEnabled = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['LLM_AGENT_ENABLED'] ?? '')
      : false
  )
  const llmEnvReady = useEnvStore((s) => s.state.status === 'ready')
  // #7 dogfood：预处理卡右侧快捷开关，写 env LLM_AGENT_ENABLED + 挂重启横幅（同抽屉启用行）。
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const handlePreprocessToggle = async (v: boolean): Promise<void> => {
    const r = await applyEnvPatch({ LLM_AGENT_ENABLED: v ? 'true' : 'false' })
    if (!r.ok) {
      toastError(t('agents.preprocess.envSaveError'), `${r.error.code}: ${r.error.message}`)
      return
    }
    if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
  }
  // env store 默认 idle（仅 SettingsShell mount 时 refresh）；进 /agents 主动拉一次，让预处理卡
  // 启用徽标 + 抽屉 enable/model 预填拿到真实 .env（否则未进过设置页 → 徽标恒灰、抽屉 stale）。
  // codex HIGH：无此 refresh 时，抽屉在 idle 下预填 enabled=false，配合 dirty 门控虽不会覆写，
  // 但显示会误导；refresh 让正常流下 env 就绪。
  useEffect(() => {
    if (useEnvStore.getState().state.status === 'idle') void useEnvStore.getState().refresh()
  }, [])

  // 所有报告 agent（type=report），按 cadence 日→周→月稳定排序，各渲染一张卡。
  const reportAgents = useMemo(() => {
    const order: Record<string, number> = { daily: 0, weekly: 1, monthly: 2 }
    return agents
      .filter((a) => a.type === 'report')
      .sort((a, b) => (order[a.schedule?.cadence] ?? 9) - (order[b.schedule?.cadence] ?? 9))
  }, [agents])
  // F4b — 搜索 agent（type='search'），按 id 稳定排序。
  const searchAgents = useMemo(
    () => agents.filter((a) => a.type === 'search').sort((a, b) => a.id.localeCompare(b.id)),
    [agents]
  )
  // v27 — AI 邮件预处理 agent（type='preprocess'，后端播种单行，正常仅 1 张卡）。
  const preprocessAgents = useMemo(() => agents.filter((a) => a.type === 'preprocess'), [agents])
  // S5 W5a — 项目周报同步 agent（type='project_progress'，后端 v31 播种单行）。
  const projectProgressAgents = useMemo(
    () => agents.filter((a) => a.type === 'project_progress'),
    [agents]
  )
  // S5 — 完全自定义 agent（type='custom'），按 id 稳定排序。此前无此 filter → custom 行被
  // 静默丢弃；补上后 custom 卡片可见。
  const customAgents = useMemo(
    () => agents.filter((a) => a.type === 'custom').sort((a, b) => a.id.localeCompare(b.id)),
    [agents]
  )
  const configAgent = useMemo(
    () => reportAgents.find((a) => a.id === configId) ?? null,
    [reportAgents, configId]
  )
  const searchConfigAgent = useMemo(
    () =>
      searchDrawer?.mode === 'edit'
        ? (searchAgents.find((a) => a.id === searchDrawer.id) ?? null)
        : null,
    [searchAgents, searchDrawer]
  )
  const customConfigAgent = useMemo(
    () =>
      customDrawer?.mode === 'edit'
        ? (customAgents.find((a) => a.id === customDrawer.id) ?? null)
        : null,
    [customAgents, customDrawer]
  )
  // 预处理只有一行（后端播种）；抽屉编辑它。
  const preprocessAgent = preprocessAgents[0] ?? null
  // 项目周报只有一行（后端播种）；抽屉编辑它。
  const projectProgressAgent = projectProgressAgents[0] ?? null
  // drawer 任一打开 → 锁列表滚动。
  const anyDrawerOpen =
    configAgent !== null ||
    searchDrawer !== null ||
    customDrawer !== null ||
    preprocessOpen ||
    projectProgressOpen

  // 三层各司其职：①外层 relative 不滚 → drawer 钉这层（不随列表滚）②滚动层 absolute inset:0
  // 承接滚动、**block 流非 flex**（子项自然高度、超出滚动，绝不压缩卡片）③内容层 flex column
  // 仅排列 + gap。drawer 打开时滚动层切 overflow:hidden → 列表锁定（不滚 + 隐藏滚动条）。
  return (
    <div style={{ position: 'relative', flex: 1, height: '100%' }}>
      {/* 滚动层 absolute 脱流，外层须有明确高度（height:100%，依赖 main 的确定高度）撑起，
          否则 absolute inset:0 塌成 0 → 整页只剩背景。 */}
      <div
        className="scrollbar-thin"
        style={{ position: 'absolute', inset: 0, overflowY: anyDrawerOpen ? 'hidden' : 'auto' }}
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

          {/* ─── Search Agents 区（F4b）─────────────────────────────────── */}
          <div style={{ marginTop: 8 }}>
            <h2
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'rgb(var(--ink-fg))',
                letterSpacing: '-0.01em'
              }}
            >
              {t('agents.search.section')}
            </h2>
            <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 4 }}>
              {t('agents.search.sectionHint')}
            </p>
          </div>
          {searchAgents.length > 0 ? (
            searchAgents.map((cfg) => (
              <SearchAgentCard
                key={cfg.id}
                cfg={cfg}
                onConfig={() => setSearchDrawer({ mode: 'edit', id: cfg.id })}
              />
            ))
          ) : (
            <div
              style={{
                borderRadius: 14,
                border: '1px solid rgb(var(--ink-border))',
                padding: '18px 20px',
                fontSize: 13,
                color: 'rgb(var(--ink-fg-3))'
              }}
            >
              {isLoading ? t('agents.reports.loading') : t('agents.search.noAgent')}
            </div>
          )}
          {/* ─── AI 邮件预处理区（v27）───────────────────────────────────── */}
          <div style={{ marginTop: 8 }}>
            <h2
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'rgb(var(--ink-fg))',
                letterSpacing: '-0.01em'
              }}
            >
              {t('agents.preprocess.section')}
            </h2>
            <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 4 }}>
              {t('agents.preprocess.sectionHint')}
            </p>
          </div>
          {preprocessAgents.length > 0 ? (
            preprocessAgents.map((cfg) => (
              <PreprocessAgentCard
                key={cfg.id}
                cfg={cfg}
                enabled={llmAgentEnabled}
                envReady={llmEnvReady}
                onConfig={() => setPreprocessOpen(true)}
                onToggle={(v) => void handlePreprocessToggle(v)}
              />
            ))
          ) : (
            <div
              style={{
                borderRadius: 14,
                border: '1px solid rgb(var(--ink-border))',
                padding: '18px 20px',
                fontSize: 13,
                color: 'rgb(var(--ink-fg-3))'
              }}
            >
              {isLoading ? t('agents.reports.loading') : t('agents.preprocess.noAgent')}
            </div>
          )}

          {/* ─── 项目周报同步区（S5 W5a）─────────────────────────────────
              仅当后端 v31 播种行存在时渲染（老库未迁移 → 不显，避免空区块）。 */}
          {projectProgressAgent && (
            <>
              <div style={{ marginTop: 8 }}>
                <h2
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'rgb(var(--ink-fg))',
                    letterSpacing: '-0.01em'
                  }}
                >
                  {t('agents.projectProgress.section')}
                </h2>
                <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 4 }}>
                  {t('agents.projectProgress.sectionHint')}
                </p>
              </div>
              <ProjectProgressAgentCard
                cfg={projectProgressAgent}
                masterEnabled={projectProgressMaster}
                onConfig={() => setProjectProgressOpen(true)}
                onToggle={(v) => void handleProjectProgressToggle(v)}
              />
            </>
          )}

          {/* ─── 完全自定义 Agents 区（S5）──────────────────────────────
              flag on 或已有 custom 行时展开 section header + 卡片；flag off 且无 custom 行
              时只留下方 NewAgentTile 禁用占位（字节级同现状）。 */}
          {(customAgentsEnabled || customAgents.length > 0) && (
            <>
              <div style={{ marginTop: 8 }}>
                <div className="flex items-center" style={{ gap: 8 }}>
                  <h2
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: 'rgb(var(--ink-fg))',
                      letterSpacing: '-0.01em'
                    }}
                  >
                    {t('agents.custom.section')}
                  </h2>
                  {customPendingTotal > 0 && (
                    <PendingDot
                      title={t('agents.custom.runs.sectionDot', { count: customPendingTotal })}
                    />
                  )}
                </div>
                <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 4 }}>
                  {t('agents.custom.sectionHint')}
                </p>
              </div>
              {customAgents.map((cfg) => (
                <CustomAgentCard
                  key={cfg.id}
                  cfg={cfg}
                  onConfig={() => setCustomDrawer({ mode: 'edit', id: cfg.id })}
                />
              ))}
            </>
          )}

          {/* Custom Agent 新建入口：flag on → 可点开抽屉；off → coming-soon 禁用占位。 */}
          <NewAgentTile
            enabled={customAgentsEnabled}
            onClick={() => setCustomDrawer({ mode: 'create' })}
          />
        </div>
      </div>
      {/* 始终挂载，由 open 驱动进/退场动画（退场播完才卸载，见 useExitAnimation）。 */}
      <ConfigDrawer
        cfg={configAgent}
        open={configAgent !== null}
        onClose={() => setConfigId(null)}
      />
      <SearchConfigDrawer
        cfg={searchConfigAgent}
        open={searchDrawer !== null}
        create={searchDrawer?.mode === 'create'}
        onClose={() => setSearchDrawer(null)}
      />
      <CustomAgentDrawer
        cfg={customConfigAgent}
        open={customDrawer !== null}
        create={customDrawer?.mode === 'create'}
        onClose={() => setCustomDrawer(null)}
      />
      <PreprocessConfigDrawer
        cfg={preprocessAgent}
        open={preprocessOpen}
        onClose={() => setPreprocessOpen(false)}
      />
      <ProjectProgressConfigDrawer
        cfg={projectProgressAgent}
        open={projectProgressOpen}
        onClose={() => setProjectProgressOpen(false)}
      />
    </div>
  )
}
