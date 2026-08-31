// task 08-27 P4d —— Agent 排程投影的详情形态。
//
// 三样主体：
//   这次要跑什么   配置行的 title + 描述 / prompt 摘要（时刻在外壳的时间行上）。
//   触发规则       渲染 `useReportConfig()` 里那一行的 trigger envelope（v1 单条 / v2 多条），
//                  文案复用团队页卡片同一批 key —— 两处说的是同一件事，不另造一套措辞。
//                  报告型 agent 的 trigger 恒 null，它的时刻在 `schedule` 里，故回落到排程句子。
//   上次跑的结果   🔴 **可缺省块**：自定义 agent 走 run 台账、报告 agent 走最近一篇报告；
//                  其余成员（画像 / 预处理 / 搜索）根本没有执行台账 —— 拿不到就**整段不渲染**，
//                  不写「暂无记录」（对那几位这是永久状态，不是暂时没有）。
//
// agenda 的 agent 源只展开 custom 与 report 两型（src/calendar_sync/agenda.py），所以这里
// 也只认这两型的执行记录。

import { ArrowUpRight } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { AgendaEntry, ReportAgentConfig, ReportStatus } from '@shared/api/types'
import { useAgentRuns, useLatestReport, useReportConfig } from '@shared/components/agents/hooks'
import { RunStateBadge } from '@shared/components/agents/custom-agent/RunHistorySection'
import { formatCalendarLead } from '@shared/components/agents/custom-agent/shared'
import { coerceRule, isScheduleValue } from '@shared/components/agents/schedule'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'

import { MetaRow } from './MetaRow'
import { ProjectionShell } from './ProjectionShell'

interface TriggerLine {
  key: string
  text: string
  /** v2 envelope 里被单独停用的那条 —— 仍然要显示（它是配置事实），但要标出来。 */
  disabled: boolean
}

/** trigger envelope → 每条一行。报告型没有 envelope，回落到 `schedule` 的排程句子。 */
function triggerLines(
  cfg: ReportAgentConfig,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale: string
): TriggerLine[] {
  const configured = cfg.trigger
  const entries = configured?.v === 2 ? configured.triggers : configured ? [configured] : []
  const lines: TriggerLine[] = []
  entries.forEach((entry, index) => {
    const disabled = 'enabled' in entry && !entry.enabled
    const key = ('id' in entry && entry.id) || `${entry.kind}-${index}`
    if (entry.kind === 'cron') {
      lines.push({
        key,
        disabled,
        text: t('agents.custom.card.triggerCron', {
          cron: entry.cron,
          tz: entry.timezone || 'UTC'
        })
      })
    } else if (entry.kind === 'schedule') {
      lines.push({
        key,
        disabled,
        text: t('agents.custom.card.triggerSchedule', {
          text: sentenceText(t, locale, coerceRule(entry.rule)),
          tz: entry.timezone
        })
      })
    } else if (entry.kind === 'email_filter') {
      lines.push({ key, disabled, text: t('agents.custom.card.triggerEmail') })
    } else if (entry.kind === 'calendar_event_change') {
      lines.push({ key, disabled, text: t('agents.custom.card.triggerCalendarChange') })
    } else {
      lines.push({
        key,
        disabled,
        text: t('agents.custom.card.triggerCalendarBefore', {
          lead: formatCalendarLead(t, entry.lead_seconds)
        })
      })
    }
  })
  if (lines.length > 0) return lines
  if (isScheduleValue(cfg.schedule)) {
    return [
      {
        key: 'schedule',
        disabled: false,
        text: t('agents.custom.card.triggerSchedule', {
          text: sentenceText(t, locale, coerceRule(cfg.schedule.rule)),
          tz: cfg.schedule.timezone || cfg.timezone || ''
        })
      }
    ]
  }
  return [{ key: 'none', disabled: false, text: t('agents.custom.card.triggerNone') }]
}

/** 报告状态词表（穷举 Record：`ReportStatus` 新增成员 → typecheck 当场红）。 */
const REPORT_STATUS_LABELS: Record<ReportStatus, [key: string, fallback: string]> = {
  generating: ['calendar.detail.reportStatus.generating', '正在生成'],
  ready: ['calendar.detail.reportStatus.ready', '已生成'],
  empty: ['calendar.detail.reportStatus.empty', '没有内容可写'],
  failed: ['calendar.detail.reportStatus.failed', '失败'],
  skipped: ['calendar.detail.reportStatus.skipped', '跳过']
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}

/** 自定义 agent 的最近一次 run（`GET /api/agent-runs` 第一行）。没有 run → 不渲染。 */
function LastCustomRun({ agentId }: { agentId: string }): React.ReactElement | null {
  const { t } = useTranslation()
  const { runs } = useAgentRuns(agentId, 1)
  const run = runs[0] ?? null
  if (!run) return null
  return (
    <MetaRow label={t('calendar.detail.lastRun', '上次跑的结果')}>
      <div>
        <div className="flex items-center gap-2">
          <RunStateBadge state={run.state} />
          <span className="font-mono text-[11px] text-ink-fg-3">
            {fmtTime(run.finishedAt ?? run.createdAt)}
            {typeof run.durationSeconds === 'number'
              ? ` · ${fmtDuration(run.durationSeconds)}`
              : ''}
          </span>
        </div>
        {(run.summary || run.error) && (
          <div className="mt-1 text-[12.5px] text-ink-fg-1">{run.summary || run.error}</div>
        )}
      </div>
    </MetaRow>
  )
}

/** 报告型没有 run 行 —— 最近一次的痕迹就是最近一篇报告（复用既有 useLatestReport，
 *  与团队页 / 报告卡共享同一份缓存）。没有报告 → 不渲染。 */
function LastReport({ agentId }: { agentId: string }): React.ReactElement | null {
  const { t } = useTranslation()
  const report = useLatestReport(agentId)
  if (!report) return null
  return (
    <MetaRow label={t('calendar.detail.lastRun', '上次跑的结果')}>
      <div>
        <div className="font-mono text-[11px] text-ink-fg-3">
          {t(...REPORT_STATUS_LABELS[report.status])}
          {report.generated_at ? ` · ${fmtTime(report.generated_at)}` : ''}
        </div>
        {(report.headline || report.error) && (
          <div className="mt-1 text-[12.5px] text-ink-fg-1">{report.headline || report.error}</div>
        )}
      </div>
    </MetaRow>
  )
}

export function AgentEntryDetail({
  entry,
  onClose
}: {
  entry: AgendaEntry
  onClose: () => void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const agentId = entry.agentId ?? null
  const { agents } = useReportConfig()
  const cfg = agents.find((row) => row.id === agentId) ?? null

  const handleJump = (): void => {
    onClose()
    navigateToNavEntry(navigate, navEntry('agents'))
  }

  const summaryText = cfg?.description?.trim() || cfg?.prompt?.trim() || ''

  return (
    <ProjectionShell
      entry={entry}
      onClose={onClose}
      roleLabel={t('calendar.detail.agentRole', 'Agent 排程')}
      timeLabel={t('calendar.detail.plannedTime', '计划时刻')}
      note={t('calendar.detail.agentNote', '这是排程的投影 —— 改时间要去 Agent 的设置里改')}
      jumpLabel={t('calendar.detail.goAgent', '去 Agent')}
      jumpTitle={t('calendar.detail.goAgentTitle', '在团队域打开这个 Agent')}
      jumpIcon={<ArrowUpRight size={13} strokeWidth={2} />}
      onJump={handleJump}
    >
      <MetaRow label={t('calendar.detail.whatRuns', '这次要跑什么')}>
        {cfg ? (
          <div>
            <div>{cfg.title}</div>
            {summaryText && (
              <div className="desc-box scrollbar-thin mt-1.5">{summaryText.slice(0, 320)}</div>
            )}
          </div>
        ) : (
          <span className="empty-field">
            {t('calendar.detail.agentMissing', '这个 Agent 的配置没取到')}
          </span>
        )}
      </MetaRow>

      {cfg && (
        <MetaRow label={t('calendar.detail.triggerRules', '触发规则')}>
          <div>
            {triggerLines(cfg, t, i18n.language || 'zh-CN').map((line) => (
              <div key={line.key} className={line.disabled ? 'text-ink-fg-3' : undefined}>
                {line.text}
                {line.disabled && ` · ${t('calendar.detail.triggerDisabled', '已停用')}`}
              </div>
            ))}
          </div>
        </MetaRow>
      )}

      {/* 🔴 可缺省块：两个子组件都可能什么都不渲染（画像 / 预处理 / 搜索永远没有执行台账，
          给它们写「暂无记录」是撒谎）。按 type 决定挂哪一个 —— 条件挂**组件**而不是条件
          调 hook，两条查询各自只在自己那一型上发。 */}
      {cfg?.type === 'custom' && agentId !== null && <LastCustomRun agentId={agentId} />}
      {cfg?.type === 'report' && agentId !== null && <LastReport agentId={agentId} />}
    </ProjectionShell>
  )
}
