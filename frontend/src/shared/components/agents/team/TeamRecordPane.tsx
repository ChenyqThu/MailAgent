// task 08-27 P4a（lane team-shell）— 记录面壳：左记录列（216px，可收起成 18px 把手）
// + 右详情。能对话与不能对话共用同一个壳（design §8.1），差别只有两处：
//   • 能对话的顶部有「新对话」，默认落新会话（P4b 起接真 composer —— TeamChatHost，
//     与主 agent 同一套运行时；origin='team' 的历史会话同样可续聊）；
//   • 不能对话的没有「新建」，默认落最新一条执行，且顶部写明为什么不接对话。
//
// 🔴 记录列是一条时间线：会话与执行按时间倒序穿插（mergeMemberTimeline），不按来源分块。
// 组件用 `key={member.key}` 挂载（TeamWorkspace 侧）——换成员时选中态自然重置。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChevronLeft, ChevronRight, MessageSquarePlus, Zap } from 'lucide-react'

import type { AgentRunState, EnrichedEmailMeta } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

import {
  useAgentOriginSessions,
  useAgentReports,
  useAgentRuns,
  useProjectProgressRuns,
  useRecentPreprocessedEmails
} from '../hooks'
import type { TeamMember } from './teamMembers'
import { mergeMemberTimeline, type TeamRecordEntry } from './teamTimeline'
import { TeamChatHost } from './TeamChatHost'
import {
  TeamPreprocessDetail,
  TeamProgressDetail,
  TeamReportDetail,
  TeamRunStatsDetail,
  TeamRunTranscript,
  TeamSessionDetail
} from './TeamRecordDetail'

const RECORD_COL_WIDTH = 216
const HANDLE_WIDTH = 18
const NEW_KEY = 'new'

// run 9 值域 → 状态点色（label 语义单源仍是 RunStateBadge；这里只管点色，满足穷举
// —— satisfies 让新增状态在这里编译红，防漏兜）。
const RUN_DOT = {
  queued: 'bg-info',
  running: 'bg-info animate-pulse',
  completed: 'bg-ok',
  skipped: 'bg-ink-fg/30',
  paused_pending: 'bg-warn',
  paused_expired: 'bg-ink-fg/30',
  paused_approved: 'bg-ok',
  paused_rejected: 'bg-fail',
  failed: 'bg-fail'
} satisfies Record<AgentRunState, string>

function relTime(epochMsValue: number, t: TFunction): string {
  const diff = Date.now() - epochMsValue
  if (diff < 60_000) return t('chat.sidebar.justNow')
  if (diff < 3_600_000) return t('chat.sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('chat.sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('chat.sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
}

interface RecordRow {
  key: string
  title: string
  at: number
  auto: boolean
  dot: string
}

function entryRow(entry: TeamRecordEntry, t: TFunction): RecordRow {
  switch (entry.kind) {
    case 'run':
      return {
        key: entry.key,
        title: entry.run.summary?.trim() || t('team.record.runUntitled'),
        at: entry.at,
        auto: entry.auto,
        dot: RUN_DOT[entry.run.state]
      }
    case 'runLog':
      // state 已是 9 值域（建表 CHECK 钉死）→ 与 run 行共用同一张点色表，零映射。
      return {
        key: entry.key,
        title: entry.runLog.summary?.trim() || t('team.record.runUntitled'),
        at: entry.at,
        auto: entry.auto,
        dot: RUN_DOT[entry.runLog.state]
      }
    case 'session':
      return {
        key: entry.key,
        title:
          entry.session.title?.trim() ||
          entry.session.email_subject?.trim() ||
          entry.session.first_user_message?.trim() ||
          t('sessions.untitled'),
        at: entry.at,
        auto: entry.auto,
        dot: 'bg-coral/100'
      }
    case 'report':
      return {
        key: entry.key,
        title: entry.report.headline?.trim() || entry.report.report_date,
        at: entry.at,
        auto: entry.auto,
        dot:
          entry.report.status === 'ready'
            ? 'bg-ok'
            : entry.report.status === 'failed'
              ? 'bg-fail'
              : entry.report.status === 'generating'
                ? 'bg-info animate-pulse'
                : 'bg-ink-fg/30'
      }
    case 'progress':
      return {
        key: entry.key,
        title:
          entry.progress.subject?.trim() ||
          entry.progress.weekTag?.trim() ||
          entry.progress.filename?.trim() ||
          t('team.record.runUntitled'),
        at: entry.at,
        auto: entry.auto,
        dot:
          entry.progress.status === 'completed'
            ? 'bg-ok'
            : entry.progress.status === 'failed'
              ? 'bg-fail'
              : entry.progress.status === 'processing'
                ? 'bg-info animate-pulse'
                : 'bg-ink-fg/30'
      }
  }
}

// llm_processing.status（原始值）→ 状态点色。老后端不返该字段（undefined）时按成功渲染
// —— 那是既有行为，不是「未知状态」。
const PREPROCESS_DOT: Record<string, string> = {
  success: 'bg-ok',
  failed: 'bg-fail',
  pending: 'bg-info animate-pulse'
}

function emailRow(email: EnrichedEmailMeta): RecordRow {
  const at = email.date_received != null ? new Date(email.date_received).getTime() : NaN
  return {
    key: `email:${email.internal_id}`,
    title: email.subject || String(email.internal_id),
    at: Number.isNaN(at) ? 0 : at,
    auto: true,
    dot: (email.llm_status != null && PREPROCESS_DOT[email.llm_status]) || 'bg-ok'
  }
}

function RecordRowButton({
  row,
  selected,
  onSelect,
  t
}: {
  row: RecordRow
  selected: boolean
  onSelect: () => void
  t: TFunction
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-record-row={row.key}
      className={cn(
        'relative w-full rounded-md border px-2 py-1.5 text-left transition-colors duration-fast',
        selected
          ? 'border-[var(--hairline-strong)] bg-ink-fg/[0.07]'
          : 'border-transparent hover:bg-ink-fg/[0.03]'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-full', row.dot)} />
        <span className="min-w-0 flex-1 truncate text-meta text-ink-fg" title={row.title}>
          {row.title}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3 font-mono text-micro text-ink-fg-3">
        {row.auto && (
          <span className="inline-flex items-center gap-0.5 text-ai" data-auto-badge>
            <Zap size={9} strokeWidth={2} />
            {t('team.record.auto')}
          </span>
        )}
        <span>{relTime(row.at, t)}</span>
      </div>
    </button>
  )
}

export function TeamRecordPane({
  member,
  memberTitle,
  collapsed,
  onToggleCollapsed,
  forcedCollapsed,
  focusSessionId,
  onFocusConsumed
}: {
  member: TeamMember
  memberTitle: string
  collapsed: boolean
  onToggleCollapsed: () => void
  /** 窄窗强制收起（判据与二级栏 forcedCollapsed 同构：留给详情的宽度不够时列让位）。 */
  forcedCollapsed: boolean
  /** 通知深链点名的那条记录（会话 id）。找不到就不动，等下一次 entries 变化。 */
  focusSessionId?: number | null
  onFocusConsumed?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const source = member.recordSource
  const agentId = member.ref.kind === 'agent' ? member.ref.agentId : null

  // 数据源按 recordSource 门控（enabled=false 的 hook 不发请求）。
  const wantsTimeline = source === 'runs' || source === 'runs-no-transcript' || source === 'report'
  const wantsRuns = source === 'runs' || source === 'runs-no-transcript'
  const { sessions } = useAgentOriginSessions(wantsTimeline)
  // 08-31 — 同一个聚合端点也返 agent_run_log 行，所以报告 / 项目周报两位也要查：它们的
  // 过程台账在那里（各自的 report / project_progress_sync 行只有结果，没有过程）。
  const { runs, runLogs } = useAgentRuns(source === 'preprocess' ? null : agentId)
  const { reports } = useAgentReports(source === 'report' ? agentId : null)
  const { runs: progressRuns } = useProjectProgressRuns(source === 'progress')
  const { emails } = useRecentPreprocessedEmails(source === 'preprocess')

  const entries = useMemo(
    () =>
      source === 'preprocess' || agentId == null
        ? []
        : mergeMemberTimeline({
            agentId,
            sessions: wantsTimeline ? sessions : [],
            runs: wantsRuns ? runs : [],
            runLogs,
            reports: source === 'report' ? reports : [],
            progressRuns: source === 'progress' ? progressRuns : []
          }),
    [source, agentId, wantsTimeline, wantsRuns, sessions, runs, runLogs, reports, progressRuns]
  )

  const rows = useMemo(
    () =>
      source === 'preprocess' ? emails.map(emailRow) : entries.map((entry) => entryRow(entry, t)),
    [source, emails, entries, t]
  )

  // 选中态：picked 仍有效用它，否则回落默认（能对话 → 新会话；否则最新一条）。
  const [picked, setPicked] = useState<string | null>(null)
  const defaultKey = member.canChat ? NEW_KEY : (rows[0]?.key ?? null)
  const effectiveKey = useMemo(() => {
    if (picked === NEW_KEY && member.canChat) return NEW_KEY
    if (picked != null && rows.some((r) => r.key === picked)) return picked
    return defaultKey
  }, [picked, rows, member.canChat, defaultKey])

  // 通知深链点名的那条记录：run 行（run.sessionId）与会话行（session.id）都可能是它 ——
  // 同一个 headless run 在时间线里只留其中一种形态（有 run 台账时会话行被去重掉）。
  // entries 在途时找不到就等下一次变化，不回落到默认选中项（那会让深链看起来「跳错了」）。
  useEffect(() => {
    if (focusSessionId == null) return
    const hit = entries.find(
      (entry) =>
        (entry.kind === 'run' && entry.run.sessionId === focusSessionId) ||
        (entry.kind === 'session' && entry.session.id === focusSessionId)
    )
    if (!hit) return
    setPicked(hit.key)
    onFocusConsumed?.()
  }, [entries, focusSessionId, onFocusConsumed])

  const effectiveCollapsed = forcedCollapsed || collapsed

  const detail = ((): React.ReactElement => {
    // P4b — 新会话默认落点 = 真 composer（与主 agent 同一套运行时）。按 key 重挂：
    // 换选中项 / 换成员时会话引擎干净重建。
    if (effectiveKey === NEW_KEY)
      return (
        <TeamChatHost
          key={`team-chat:${member.key}:new`}
          member={member}
          memberTitle={memberTitle}
          sessionId={null}
          sessionRow={null}
        />
      )
    if (source === 'preprocess') {
      const email = emails.find((e) => `email:${e.internal_id}` === effectiveKey) ?? null
      if (email) return <TeamPreprocessDetail email={email} />
    } else {
      const entry = entries.find((e) => e.key === effectiveKey) ?? null
      if (entry) {
        switch (entry.kind) {
          case 'run':
            return entry.run.sessionId != null ? (
              <TeamRunTranscript run={entry.run} agentName={memberTitle} />
            ) : (
              <TeamRunStatsDetail run={entry.run} />
            )
          case 'runLog':
            return <TeamRunTranscript run={entry.runLog} agentName={memberTitle} />
          case 'session':
            // P4b — origin='team'（人以它身份开的交互会话）→ 续聊（真 composer）；
            // origin='agent'（headless run 的降级形态行）维持只读 —— untrusted trigger
            // 历史绝不给 manual 续写（P4 红线镜像，见 AgentConversation.isAgentRecord）。
            return entry.session.origin === 'team' && member.canChat ? (
              <TeamChatHost
                key={`team-chat:${member.key}:${entry.session.id}`}
                member={member}
                memberTitle={memberTitle}
                sessionId={entry.session.id}
                sessionRow={entry.session}
              />
            ) : (
              <TeamSessionDetail session={entry.session} />
            )
          case 'report':
            return <TeamReportDetail report={entry.report} />
          case 'progress':
            return <TeamProgressDetail progress={entry.progress} />
        }
      }
    }
    // 一条记录都没有：说清原因（prd「记录为空时说清原因，不能只写暂无」）。
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center">
        <p className="max-w-[26rem] text-meta leading-relaxed text-ink-fg-3">{emptyReason()}</p>
      </div>
    )
  })()

  function emptyReason(): string {
    switch (source) {
      case 'runs':
      case 'runs-no-transcript':
        return t('team.record.emptyRuns')
      case 'report':
        return t('team.record.emptyReports')
      case 'progress':
        return t('team.record.emptyProgress')
      case 'preprocess':
        return t('team.record.emptyPreprocess')
      default:
        return t('team.record.emptyRuns')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-team-record-pane>
      {/* 不接对话的成员：顶部写明为什么（design §8.0 —— 否则看起来像功能缺失）。 */}
      {member.noChatReasonKey != null && (
        <div
          className="shrink-0 border-b border-ink-border-soft px-4 py-2 text-meta leading-relaxed text-ink-fg-2"
          data-no-chat-reason
        >
          {t(member.noChatReasonKey)}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {effectiveCollapsed ? (
          !forcedCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={t('team.record.expandList')}
              title={t('team.record.expandList')}
              className="flex shrink-0 items-center justify-center border-r border-ink-border-soft text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              style={{ width: HANDLE_WIDTH }}
              data-record-col-handle
            >
              <ChevronRight size={13} strokeWidth={2} />
            </button>
          )
        ) : (
          <div
            className="flex h-full shrink-0 flex-col border-r border-ink-border-soft"
            style={{ width: RECORD_COL_WIDTH }}
            data-record-col
          >
            <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
              {member.canChat ? (
                <button
                  type="button"
                  onClick={() => setPicked(NEW_KEY)}
                  data-record-new
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-meta font-medium transition-colors duration-fast',
                    effectiveKey === NEW_KEY
                      ? 'border-[var(--hairline-strong)] bg-ink-fg/[0.07] text-ink-fg'
                      : 'border-transparent text-ink-fg-1 hover:bg-ink-fg/[0.03] hover:text-ink-fg'
                  )}
                >
                  <MessageSquarePlus size={13} strokeWidth={2} className="shrink-0" />
                  <span className="truncate">{t('team.record.new')}</span>
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
                  {t('team.record.listTitle')}
                </span>
              )}
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label={t('team.record.collapseList')}
                title={t('team.record.collapseList')}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              >
                <ChevronLeft size={13} strokeWidth={2} />
              </button>
            </div>
            <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
              {rows.length === 0 ? (
                <p className="px-2 py-4 text-micro leading-relaxed text-ink-fg-3">
                  {emptyReason()}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {rows.map((row) => (
                    <RecordRowButton
                      key={row.key}
                      row={row}
                      selected={row.key === effectiveKey}
                      onSelect={() => setPicked(row.key)}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {detail}
      </div>
    </div>
  )
}
