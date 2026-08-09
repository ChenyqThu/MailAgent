// Sprint 20 — Agents tab：邮件日报 agent 概览卡（启用/运行/配置 + 最近报告）+
// 配置 slide-over（prompt / 排程 / 触发模式 / 带正文优先级 / 模型 / KOS 增强）+ 新建占位。
// 移植自 ~/Downloads/agents/agents-tab.jsx，接 report:getConfig/setConfig/runNow。
// 配置抽屉（Config/Search/Preprocess/ProjectProgress）已机械抽到 ./drawers；本文件保留概览卡
// 与 tab 装配，抽屉经 import 组合渲染。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig } from '@shared/api/types'
import { ReportIcon, StatusBadge, Switch } from './primitives'
import { CustomAgentDrawer, RunStateBadge } from './CustomAgentDrawer'
import { AgentPendingCountBadge, PendingDot } from './AgentPendingBadge'
import {
  useAgentPendingCount,
  useAgentPluginsEnabled,
  useAgentUnreadCount,
  useCalendarTriggerEnabled,
  useAgentRuns,
  useCustomAgentsEnabled,
  useSessionProvenanceEnabled,
  useLatestReport,
  useReportConfig,
  useRunNow,
  useSetConfig
} from './hooks'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useRestartStore } from '@shared/state/restart'
import { toastError } from '@shared/state/toast'
import { IS_WEB, PRESS_SCALE, PROJECT_PROGRESS_AGENT_ID, envFlagOn, pressHandlers } from './shared'
import { ConfigDrawer } from './drawers/ConfigDrawer'
import { SearchConfigDrawer } from './drawers/SearchConfigDrawer'
import { PreprocessConfigDrawer } from './drawers/PreprocessConfigDrawer'
import { ProjectProgressConfigDrawer } from './drawers/ProjectProgressConfigDrawer'
import { AgentAvatar } from './AgentAvatar'
import { coerceRule, isScheduleValue } from './schedule'
import { sentenceText } from './schedule/sentence'
import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { formatCalendarLead } from './custom-agent/shared'

function scheduleText(
  cfg: ReportAgentConfig,
  t: (k: string, o?: Record<string, unknown>) => string,
  locale: string
): string {
  // 07-24 结构化排程：老三句模板表达不了 interval / 第 N 个星期几 / 非整点分钟
  // （monthly+nth 时 day_of_month 镜像根本不存在，会退成「每月 1 日」——错的），
  // 故新形状直接复用构建器同一套句子生成器，卡片与抽屉口径天然一致。
  if (isScheduleValue(cfg.schedule)) {
    return sentenceText(t, locale, coerceRule(cfg.schedule.rule))
  }
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
  const { t, i18n } = useTranslation()
  const { save } = useSetConfig()
  const { run, isRunning } = useRunNow()
  // codex MEDIUM-2 — 该 agent 的最近一份报告：走 agentId 过滤 + limit:1 的按 agent 查询（不再从
  // 全部-list 首屏 50 条里 find —— 低频 agent 的最新报告一旦被挤出首页会误显示「无历史」）。
  const last = useLatestReport(cfg.id)

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
        <AgentAvatar agentId={cfg.id} config={cfg.avatar} size={42} title={cfg.title} />
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
              {scheduleText(cfg, t, i18n.language || 'zh-CN')}
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
  const { t, i18n } = useTranslation()
  const { save } = useSetConfig()
  // 最近一次 run 的状态徽标（listRuns 读失败/无 run → 不显徽标）。
  const { runs } = useAgentRuns(cfg.id)
  const lastRun = runs[0] ?? null
  // 红点链 ②（P5）：该 agent 待审批（paused_pending）计数徽标（共享 pending-count 轮询，flag off →
  // 不轮询 → 恒 0 → 不渲染）。
  const customAgentsEnabled = useCustomAgentsEnabled()
  const pendingCount = useAgentPendingCount(customAgentsEnabled).byAgent[cfg.id] ?? 0
  const provenanceEnabled = useSessionProvenanceEnabled()
  const unreadCount = useAgentUnreadCount(provenanceEnabled).byAgent[cfg.id] ?? 0
  const toggle = (v: boolean): void => {
    void save(cfg.id, { enabled: v })
  }

  const triggerSummary = ((): string => {
    const configured = cfg.trigger
    const triggers = configured?.v === 2 ? configured.triggers : configured ? [configured] : []
    const trig = triggers.find((entry) => !('enabled' in entry) || entry.enabled) ?? triggers[0]
    const suffix = triggers.length > 1 ? ` · +${triggers.length - 1}` : ''
    if (trig?.kind === 'cron') {
      return `${t('agents.custom.card.triggerCron', { cron: trig.cron, tz: trig.timezone || 'UTC' })}${suffix}`
    }
    // 07-24 结构化排程：摘要用构建器同一套句子生成器（卡片与抽屉口径一致）。
    if (trig?.kind === 'schedule') {
      return `${t('agents.custom.card.triggerSchedule', {
        text: sentenceText(t, i18n.language || 'zh-CN', coerceRule(trig.rule)),
        tz: trig.timezone
      })}${suffix}`
    }
    if (trig?.kind === 'email_filter') return `${t('agents.custom.card.triggerEmail')}${suffix}`
    if (trig?.kind === 'calendar_event_change') {
      return `${t('agents.custom.card.triggerCalendarChange')}${suffix}`
    }
    if (trig?.kind === 'calendar_before_start') {
      return `${t('agents.custom.card.triggerCalendarBefore', {
        lead: formatCalendarLead(t, trig.lead_seconds)
      })}${suffix}`
    }
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
      <AgentAvatar agentId={cfg.id} config={cfg.avatar} size={42} title={cfg.title} />
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
          {unreadCount > 0 && (
            <span className="rounded-full bg-[rgb(var(--c-accent))] px-1.5 text-[10px] font-semibold text-white">
              {unreadCount}
            </span>
          )}
        </div>
        {cfg.description && (
          <div
            style={{
              fontSize: 12.5,
              color: 'rgb(var(--ink-fg-2))',
              marginTop: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {cfg.description}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
          {triggerSummary}
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Switch on={cfg.enabled} onChange={toggle} />
      </div>
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
      <AgentAvatar agentId={cfg.id} config={cfg.avatar} size={42} title={cfg.title} />
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
      <AgentAvatar agentId={cfg.id} config={cfg.avatar} size={42} title={cfg.title} />
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
      <AgentAvatar agentId={cfg.id} config={cfg.avatar} size={42} title={cfg.title} />
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

// ─── 报告生成服务总闸行（Lane 2 #10，env MAILAGENT_REPORT_AGENT_ENABLED）──────
// 同型的 PROJECT_PROGRESS_SYNC_ENABLED 总闸早有 UI（周报抽屉），报告总闸此前只能改 .env。
// 🔴 与项目周报「总闸未开=卡片禁用」不同，这里是 **OR 语义**（service.py:737）：worker
// 在「flag 开 OR 任一报告行 enabled」时启动。所以 flag 关不等于报告不可用——差别只在
// 「首次启用某个报告后要不要重启一次」：flag 开 = worker 常驻，启用报告即刻生效；
// flag 关 = 启动时无 enabled 行则 worker 不在跑，首次启用后需重启一次。按真实语义写
// hint，不给报告卡加会说谎的「总闸未开」徽标。
function ReportMasterRow(): React.ReactElement {
  const { t } = useTranslation()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const masterOn = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['MAILAGENT_REPORT_AGENT_ENABLED'] ?? '')
      : false
  )
  const handleToggle = async (v: boolean): Promise<void> => {
    const r = await applyEnvPatch({ MAILAGENT_REPORT_AGENT_ENABLED: v ? 'true' : 'false' })
    if (!r.ok) {
      toastError(t('agents.reportsMaster.saveError'), `${r.error.code}: ${r.error.message}`)
      return
    }
    if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
  }
  return (
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
          {t('agents.reportsMaster.label')}
        </div>
        <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
          {t('agents.reportsMaster.hint')}
        </div>
      </div>
      <span
        onClick={(e) => e.stopPropagation()}
        style={
          !envReady || IS_WEB
            ? { opacity: 0.5, pointerEvents: 'none', display: 'flex', flexShrink: 0 }
            : { display: 'flex', flexShrink: 0 }
        }
      >
        <Switch on={masterOn} onChange={(v) => void handleToggle(v)} />
      </span>
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
  const agentPluginsEnabled = useAgentPluginsEnabled()
  const calendarTriggerEnabled = useCalendarTriggerEnabled()
  const queryClient = useQueryClient()
  const importRef = useRef<HTMLInputElement>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  async function importAgent(body: Record<string, unknown>): Promise<void> {
    try {
      const response = await fetch(`${resolveApiBaseUrl()}/report-agents/import`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
      const envelope = (await response.json()) as { data?: { agent?: ReportAgentConfig; unmet_dependencies?: Array<{ type: string; ref: string }> }; error?: { message?: string } }
      if (!response.ok || !envelope.data?.agent) throw new Error(envelope.error?.message ?? response.statusText)
      await queryClient.invalidateQueries({ queryKey: ['report', 'config'] })
      const unmet = envelope.data.unmet_dependencies ?? []
      setImportNotice(unmet.length ? t('agents.custom.unmetDependencies', { items: unmet.map((item) => `${item.type}: ${item.ref}`).join(', ') }) : null)
      setCustomDrawer({ mode: 'edit', id: envelope.data.agent.id })
    } catch (error) {
      toastError(t('agents.custom.import'), errorMessage(error))
    }
  }
  async function importAgentFile(file: File): Promise<void> {
    try {
      await importAgent({ payload: JSON.parse(await file.text()) as unknown })
    } catch (error) {
      toastError(t('agents.custom.import'), errorMessage(error))
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }
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
      toastError(t('agents.projectProgress.rowSaveError'), errorMessage(e))
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
          {/* 报告 Agents 区 —— tab 改名为「Agents」后，本区不再是页级标题（tab 按钮本身即
              页标题），降格为与下方 search / preprocess / custom 各区一致的 h2 小节标题。 */}
          <div>
            <h2
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'rgb(var(--ink-fg))',
                letterSpacing: '-0.01em'
              }}
            >
              {t('agents.title')}
            </h2>
            <p style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))', marginTop: 4 }}>
              {t('agents.subtitle')}
            </p>
          </div>
          {/* Lane 2 #10 — env 总闸行（OR 语义，见 ReportMasterRow 注释）。 */}
          <ReportMasterRow />
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
          {customAgentsEnabled && agentPluginsEnabled ? <div className="flex flex-wrap items-center gap-2">
            <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importAgentFile(file)
            }} />
            <button type="button" className="btn-ghost" onClick={() => importRef.current?.click()}>{t('agents.custom.import')}</button>
            <button type="button" className="btn-ghost" onClick={() => void importAgent({ template: 'meeting_prep' })}>{t('agents.custom.meetingPrepTemplate')}</button>
            {!calendarTriggerEnabled ? <span className="text-meta text-warn">{t('agents.custom.calendarRequired')}</span> : null}
            {importNotice ? <div className="w-full text-meta text-warn">{importNotice}</div> : null}
          </div> : null}
        </div>
      </div>
      {/* 始终挂载，由 open 驱动进/退场动画（退场播完才卸载，见 useExitAnimation）。 */}
      <ConfigDrawer
        cfg={configAgent}
        open={configAgent !== null}
        onClose={() => setConfigId(null)}
        onOpenReports={onOpenReports}
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

// ConfigDrawer / SearchConfigDrawer 已机械抽到 ./drawers；为保持既有测试 / 消费方从 AgentsTab
// 取这两个抽屉的 import 面不变，在此原样 re-export（本身仍作为上方 tab 装配的渲染组件）。
export { ConfigDrawer, SearchConfigDrawer }
