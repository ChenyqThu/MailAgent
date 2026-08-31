// task 08-27 P4a（lane team-shell）— 记录面右侧详情：随选中项类型变（design §8.1）。
//
//   run(有 session)  → transcript（合成触发气泡 + 思考/工具/输出 + 原始 prompt 折叠块）
//   run(无 session)  → 统计摘要（联系人画像：sessionId 恒 null，r8 §A.0）
//   session          → 只读 transcript（+ 能对话成员的「即将可用」禁用 composer）
//   report           → 「触发 → 输出」两节式（报告本身即记录，无过程 transcript）
//   progress         → 项目周报：触发（邮件）→ 结果计数 → 失败处置说明
//
// 🔴 执行详情**永远是对话形态**不是日志块 —— transcript 渲染器与会话共用
// （AgentThread readOnly / ReadOnlyTranscript），差别只在第一条消息是谁发的。

import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FileChartLine, Zap } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import type {
  AgentRunHistoryItem,
  ChatMessage,
  ChatSessionListItem,
  EnrichedEmailMeta,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { navigateToReport } from '@shared/navigation/registry'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'
import { ReadOnlyTranscript } from '@shared/assistant/ReadOnlyTranscript'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'

import { AgentThread } from '../AgentThread'
import { InRecordApprovalPanel } from '../AgentRecordView'
import { RunStateBadge } from '../CustomAgentDrawer'
import { StatusBadge } from '../primitives'
import { AgentRunTriggerBubble, RunRawPromptBlock } from '../runRecordBlocks'
import { splitRunTranscript } from './runTranscript'
import { epochMs } from './teamTimeline'

function fmtDateTime(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function fmtDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

function DetailHeader({
  left,
  right
}: {
  left: React.ReactNode
  right?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-ink-border-soft px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
      {right}
    </div>
  )
}

function useSessionMessages(sessionId: number | null): {
  messages: ChatMessage[]
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.chat.messages(sessionId ?? -1),
    queryFn: () => api.chat.listMessages(sessionId as number),
    enabled: sessionId != null,
    staleTime: 10_000
  })
  return { messages: q.data ?? [], isLoading: q.isLoading }
}

// ─── run（有 session）→ transcript ──────────────────────────────────────────
export function TeamRunTranscript({
  run,
  agentName
}: {
  run: AgentRunHistoryItem
  agentName: string
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const sessionId = run.sessionId ?? null
  const { messages, isLoading } = useSessionMessages(sessionId)
  const split = useMemo(() => splitRunTranscript(messages), [messages])
  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl() ?? '', [])
  const duration = fmtDuration(run.durationSeconds)

  const triggerBubble = (
    <AgentRunTriggerBubble triggerKind={run.triggerKind} firedAtIso={run.triggerFiredAtIso} />
  )
  const onDecided = (): void => {
    void qc.invalidateQueries({ queryKey: qk.agentRuns.all() })
    void qc.invalidateQueries({ queryKey: qk.chat.messages(sessionId ?? -1) })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-team-run-detail={run.jobId}>
      <DetailHeader
        left={
          <>
            <RunStateBadge state={run.state} />
            <span className="min-w-0 flex-1 truncate text-body font-medium text-ink-fg">
              {run.summary?.trim() || t('team.record.runUntitled')}
            </span>
          </>
        }
        right={
          <span className="shrink-0 font-mono text-micro text-ink-fg-3">
            {fmtDateTime(epochMs(run.createdAt))}
            {duration ? ` · ${duration}` : ''}
          </span>
        }
      />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-meta text-ink-fg-3">
          {t('agents.reports.loading')}
        </div>
      ) : split.rest.length === 0 ? (
        // run 未产生任何回复（失败/取消）——不挂 AgentThread（其空态是「新对话」欢迎屏）。
        <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-4">
          {triggerBubble}
          <div className="mx-auto mb-5 w-full max-w-[var(--thread-max-width)] text-meta text-ink-fg-3">
            {run.error
              ? t('team.record.noOutputError', { error: run.error })
              : t('team.record.noOutput')}
          </div>
          {split.seedPrompt != null && <RunRawPromptBlock prompt={split.seedPrompt} />}
        </div>
      ) : (
        <AiSdkRuntimeProvider
          key={`team-run:${run.jobId}`}
          gatewayBaseUrl={gatewayBaseUrl}
          sessionId={null}
          initialMessages={split.rest.map(chatMessageToUIMessage)}
        >
          <AgentThread
            readOnly
            headerSlot={triggerBubble}
            pendingSlot={
              <>
                <InRecordApprovalPanel
                  sessionId={sessionId}
                  runState={run.state}
                  agentName={agentName}
                  onDecided={onDecided}
                />
                {split.seedPrompt != null && <RunRawPromptBlock prompt={split.seedPrompt} />}
              </>
            }
          />
        </AiSdkRuntimeProvider>
      )}
    </div>
  )
}

// ─── run（无 session）→ 统计摘要（联系人画像） ─────────────────────────────
export function TeamRunStatsDetail({ run }: { run: AgentRunHistoryItem }): React.ReactElement {
  const { t } = useTranslation()
  const duration = fmtDuration(run.durationSeconds)
  const tokenTotal = useMemo(() => {
    if (run.tokens == null) return null
    let sum = 0
    for (const v of Object.values(run.tokens)) if (typeof v === 'number') sum += v
    return sum > 0 ? sum : null
  }, [run.tokens])
  return (
    <div
      className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4"
      data-team-run-stats={run.jobId}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <RunStateBadge state={run.state} />
          <span className="font-mono text-micro text-ink-fg-3">
            {fmtDateTime(epochMs(run.createdAt))}
          </span>
        </div>
        {run.summary?.trim() && (
          <p className="text-body leading-relaxed text-ink-fg">{run.summary}</p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta text-ink-fg-2">
          {duration && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.duration')}</dt>
              <dd className="font-mono">{duration}</dd>
            </>
          )}
          {run.steps != null && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.steps')}</dt>
              <dd className="font-mono">{run.steps}</dd>
            </>
          )}
          {tokenTotal != null && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.tokens')}</dt>
              <dd className="font-mono">{tokenTotal.toLocaleString()}</dd>
            </>
          )}
          {run.error && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.error')}</dt>
              <dd className="text-fail [overflow-wrap:anywhere]">{run.error}</dd>
            </>
          )}
        </dl>
        <p className="text-meta text-ink-fg-3">{t('team.detail.noTranscript')}</p>
      </div>
    </div>
  )
}

// ─── session → 只读 transcript（+ 能对话成员的禁用 composer） ───────────────
export function TeamSessionDetail({
  session,
  canChat
}: {
  session: ChatSessionListItem
  canChat: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const { messages, isLoading } = useSessionMessages(session.id)
  const title =
    session.title?.trim() ||
    session.email_subject?.trim() ||
    session.first_user_message?.trim() ||
    t('sessions.untitled')
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-team-session-detail={session.id}>
      <DetailHeader
        left={
          <span className="min-w-0 flex-1 truncate text-body font-medium text-ink-fg" title={title}>
            {title}
          </span>
        }
        right={
          <span className="shrink-0 font-mono text-micro text-ink-fg-3">
            {fmtDateTime(epochMs(session.updated_at))}
          </span>
        }
      />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-meta text-ink-fg-3">
          {t('agents.reports.loading')}
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-meta text-ink-fg-3">
          {t('agents.chats.emptyTranscript')}
        </div>
      ) : (
        <ReadOnlyTranscript messages={messages} sessionKey={session.id} />
      )}
      {canChat && <PendingComposerBar />}
    </div>
  )
}

/** 「以它身份对话」的写侧还没通（P4b，design §8.5）——composer 禁用 + 一句说明。 */
export function PendingComposerBar(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 border-t border-ink-border-soft px-4 py-3" data-pending-composer>
      <div className="flex h-9 items-center rounded-lg border border-[var(--hairline)] bg-ink-2/60 px-3 text-meta text-ink-fg-3">
        {t('team.composer.pending')}
      </div>
    </div>
  )
}

// ─── report → 「触发 → 输出」两节式 ─────────────────────────────────────────
export function TeamReportDetail({ report }: { report: ReportListItem }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const generatedAt = epochMs(report.generated_at ?? report.created_at)
  const createdAt = epochMs(report.created_at)
  const duration =
    report.generated_at != null && report.created_at != null && generatedAt > createdAt
      ? fmtDuration((generatedAt - createdAt) / 1000)
      : null
  return (
    <div
      className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4"
      data-team-report-detail={report.id}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-4">
        {/* 触发节 */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-meta font-medium text-ai">
            <Zap size={12} strokeWidth={2} />
            {t('team.detail.report.trigger')}
          </div>
          <div className="rounded-lg border border-ai/30 bg-ai/10 px-3.5 py-2.5 text-body text-ink-fg">
            {t('team.detail.report.triggerBody', {
              cadence: t(`agents.cadence.${report.cadence}`),
              date: report.report_date
            })}
          </div>
        </section>
        {/* 输出节 */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-meta font-medium text-ink-fg-2">
            <FileChartLine size={12} strokeWidth={2} />
            {t('team.detail.report.output')}
          </div>
          <div className="rounded-lg border border-[var(--hairline)] bg-ink-2/60 px-3.5 py-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={report.status} />
              <span className="font-mono text-micro text-ink-fg-3">
                {generatedAt ? fmtDateTime(generatedAt) : ''}
                {duration ? ` · ${duration}` : ''}
              </span>
            </div>
            <p className="mt-2 text-body leading-relaxed text-ink-fg">{report.headline}</p>
            {report.error && (
              <p className="mt-2 text-meta text-fail [overflow-wrap:anywhere]">{report.error}</p>
            )}
            <div className="mt-2.5 flex items-center gap-3 font-mono text-micro text-ink-fg-3">
              {report.model && <span>{report.model}</span>}
              {report.input_tokens != null && report.output_tokens != null && (
                <span>
                  {t('team.detail.tokensInOut', {
                    input: report.input_tokens,
                    output: report.output_tokens
                  })}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => navigateToReport(navigate, report.id)}
              className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-ink-border px-2.5 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
            >
              <ExternalLink size={12} strokeWidth={2} />
              {t('team.detail.report.open')}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

// ─── progress → 项目周报（不走 AI：触发 → 结果计数，天然无思考块） ──────────
// 自有 status 词表（processing/completed/failed/skipped，r8 §A.1）——复用抽屉执行历史
// 区的既有 label 键，未知值回退原文。
const PROGRESS_STATUS_KEYS: Record<string, string> = {
  completed: 'agents.projectProgress.runs.statusCompleted',
  failed: 'agents.projectProgress.runs.statusFailed',
  skipped: 'agents.projectProgress.runs.statusSkipped',
  processing: 'agents.projectProgress.runs.statusProcessing'
}

export function TeamProgressDetail({
  progress
}: {
  progress: ProjectProgressRunItem
}): React.ReactElement {
  const { t } = useTranslation()
  const failed = progress.status === 'failed'
  const duration =
    progress.startedAt != null && progress.completedAt != null
      ? fmtDuration(epochMs(progress.completedAt) / 1000 - epochMs(progress.startedAt) / 1000)
      : null
  return (
    <div
      className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4"
      data-team-progress-detail={progress.internalId}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-4">
        <AgentRunTriggerBubble
          triggerKind="email_filter"
          firedAtIso={
            progress.startedAt != null ? new Date(epochMs(progress.startedAt)).toISOString() : null
          }
          detail={progress.subject?.trim() || progress.filename?.trim() || null}
        />
        <div className="rounded-lg border border-[var(--hairline)] bg-ink-2/60 px-3.5 py-3">
          <div className="flex items-center gap-2 text-body font-medium text-ink-fg">
            <span>
              {PROGRESS_STATUS_KEYS[progress.status] != null
                ? t(PROGRESS_STATUS_KEYS[progress.status])
                : progress.status}
            </span>
            {duration && <span className="font-mono text-micro text-ink-fg-3">{duration}</span>}
          </div>
          {progress.projectsTotal != null && (
            <p className="mt-2 text-meta text-ink-fg-2">
              {t('team.detail.progress.counts', {
                total: progress.projectsTotal ?? 0,
                created: progress.projectsCreated ?? 0,
                updated: progress.projectsUpdated ?? 0,
                failed: progress.projectsFailed ?? 0
              })}
            </p>
          )}
          {failed && (
            <div className="mt-2.5 rounded-md border border-fail/25 bg-fail/10 px-3 py-2 text-meta leading-relaxed text-ink-fg-1">
              {progress.error && (
                <p className="font-mono text-fail [overflow-wrap:anywhere]">{progress.error}</p>
              )}
              {/* prd：失败案例写出为什么这么处置，不是只写「失败」。 */}
              <p className="mt-1 text-ink-fg-2">{t('team.detail.progress.failNote')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── preprocess → 单封邮件的分类结果 ────────────────────────────────────────
export function TeamPreprocessDetail({ email }: { email: EnrichedEmailMeta }): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const aiQ = useQuery({
    queryKey: qk.email.ai(email.internal_id),
    queryFn: () => api.email.aiFields(email.internal_id),
    staleTime: 30_000
  })
  const ai = aiQ.data ?? null
  const chips = [email.ai_priority, email.ai_action, email.ai_category].filter(
    (v): v is string => v != null && v !== ''
  )
  return (
    <div
      className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4"
      data-team-preprocess-detail={email.internal_id}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-3">
        <h3 className="text-body font-semibold leading-snug text-ink-fg">{email.subject}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c}
              className="rounded-md border border-ink-border bg-ink-3/60 px-2 py-0.5 text-meta text-ink-fg-1"
            >
              {c}
            </span>
          ))}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta text-ink-fg-2">
          {ai?.ai_model && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.model')}</dt>
              <dd className="font-mono">{ai.ai_model}</dd>
            </>
          )}
          {ai?.ai_review_status && (
            <>
              <dt className="text-ink-fg-3">{t('team.detail.reviewStatus')}</dt>
              <dd>{ai.ai_review_status}</dd>
            </>
          )}
        </dl>
        <p className="text-meta text-ink-fg-3">{t('team.preprocess.detailHint')}</p>
      </div>
    </div>
  )
}
