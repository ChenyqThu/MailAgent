// task 08-27 P4a（lane team-shell）— 记录面右侧详情：随选中项类型变（design §8.1）。
//
//   run(有 session)  → transcript（合成触发气泡 + 思考/工具/输出 + 原始 prompt 折叠块）
//   run(无 session)  → 统计摘要（async_jobs 行没留下 session 时的降级；08-31 起联系人画像
//                      不再走这一支，它的记录改落 agent_run_log → runLog 分支）
//   runLog           → transcript（agent_run_step 合成，见下方 TeamRunTranscript 头注）
//   session          → 只读 transcript（仅 origin='agent' 降级形态行；origin='team' 的
//                      交互会话在 TeamRecordPane 分流到 TeamChatHost 真 composer 续聊，P4b）
//   report           → 「触发 → 输出」两节式（报告本身即记录，无过程 transcript）
//   progress         → 项目周报：触发（邮件）→ 结果计数 → 失败处置说明
//
// 🔴 执行详情**永远是对话形态**不是日志块 —— transcript 渲染器与会话共用
// （AgentThread readOnly / ReadOnlyTranscript），差别只在第一条消息是谁发的。

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ExternalLink, FileChartLine, Zap } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import type {
  AgentRunHistoryItem,
  AgentRunLogItem,
  ChatMessage,
  ChatSessionListItem,
  EnrichedEmailMeta,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { isRunLogItem } from '@shared/lib/agentRunItems'
import { navigateToReport } from '@shared/navigation/registry'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'
import { ReadOnlyTranscript } from '@shared/assistant/ReadOnlyTranscript'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'

import { ErrorBoundary } from '@shared/components/ErrorBoundary'

import { AgentThread } from '../AgentThread'
import { InRecordApprovalPanel } from '../AgentRecordView'
import { RunStateBadge } from '../CustomAgentDrawer'
import { StatusBadge } from '../primitives'
import { AgentRunTriggerBubble } from '../runRecordBlocks'
import { BlockRenderer } from '../BlockRenderer'
import { EmailSourcePanel } from '../EmailSourcePanel'
import { FIXED_RENDER, scrollToEmail, type RenderCtx, type ReportEmailItemForPanel } from '../lib'
import { useReport, useRunLogSteps } from '../hooks'
import { runStepsToUIMessages, splitRunTranscript } from './runTranscript'
import { epochMs, isoMs } from './teamTimeline'

// 08-31 dogfood — 执行详情面板在宽窗口下能到 ~1500px，44rem 的默认消息列两侧各空 ~400px
// （owner 观感「太靠右」，实为对称居中的窄列）。这一处放宽，其余 chat 视图不动。
const TEAM_THREAD_MAX_WIDTH = 'min(58rem, 100%)'

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

// ─── run → transcript ───────────────────────────────────────────────────────
//
// 一个组件吃两种台账（08-31）：
//   • gateway headless run（有 session）→ ai_chat_messages → chatMessageToUIMessage
//   • agent_run_log（报告 / 画像 / 项目周报，无 session）→ agent_run_step → runStepsToUIMessages
// 🔴 两条路合成的都是 `UIMessage[]`，往下共用同一个渲染器 —— 不为「不走 gateway 的成员」
// 造第二套日志式详情（design §8.1「执行详情也是 transcript」）。
export function TeamRunTranscript({
  run,
  agentName
}: {
  run: AgentRunHistoryItem | AgentRunLogItem
  agentName: string
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // 两种台账在这一处归一，下面不再第二次判 kind。唯一的形状差是时间：run_log 的
  // createdAt 是 ISO 字符串，async_jobs run 行是 epoch 数（isoMs / epochMs 各管一侧）。
  const view = isRunLogItem(run)
    ? {
        sessionId: null,
        runLogId: run.runLogId,
        state: run.state,
        startedMs: isoMs(run.createdAt),
        durationSeconds: run.durationSeconds ?? null,
        key: `runlog:${run.runLogId}`,
        triggerKind: run.triggerKind,
        firedAtIso: run.triggerFiredAtIso,
        triggerDetail: run.triggerDetail,
        reportId: run.reportId ?? null
      }
    : {
        sessionId: run.sessionId ?? null,
        runLogId: null,
        state: run.state,
        startedMs: epochMs(run.createdAt),
        durationSeconds: run.durationSeconds ?? null,
        key: `job:${run.jobId}`,
        triggerKind: run.triggerKind,
        firedAtIso: run.triggerFiredAtIso,
        triggerDetail: null,
        reportId: null
      }
  // 🔴 两个数据源都恒调 hook，靠 enabled（null id）门控发不发请求——不条件调 hook。
  const { messages, isLoading: loadingMessages } = useSessionMessages(view.sessionId)
  const { steps, isLoading: loadingSteps } = useRunLogSteps(view.runLogId)
  const split = useMemo(() => splitRunTranscript(messages), [messages])
  const isLog = view.runLogId != null
  const initialMessages = useMemo(
    () => (isLog ? runStepsToUIMessages(steps) : split.rest.map(chatMessageToUIMessage)),
    [isLog, steps, split.rest]
  )
  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl() ?? '', [])
  const duration = fmtDuration(view.durationSeconds)
  const isLoading = isLog ? loadingSteps : loadingMessages
  // 产物入口：这次执行的 report 行已被记录列去重掉（teamTimeline），报告只能从这里进。
  // 跳转载荷复用 TeamReportDetail 那一处的 navigateToReport，不新造路由逻辑。
  const navigate = useNavigate()
  const reportId = view.reportId

  // 08-31 dogfood — 完整触发指令收进触发气泡自身（原来是流末尾的独立折叠块，owner 找不到）。
  const triggerBubble = (
    <AgentRunTriggerBubble
      triggerKind={view.triggerKind}
      firedAtIso={view.firedAtIso}
      detail={view.triggerDetail}
      prompt={split.seedPrompt}
    />
  )
  const onDecided = (): void => {
    void qc.invalidateQueries({ queryKey: qk.agentRuns.all() })
    void qc.invalidateQueries({ queryKey: qk.chat.messages(view.sessionId ?? -1) })
  }
  // 报告全文的溯源面板：absolute inset-0 铺满最近的定位祖先 → 必须挂在详情面根上，
  // 不能留在折叠块里（那样只会盖住折叠块自己那一小格）。
  const [sourceEmail, setSourceEmail] = useState<ReportEmailItemForPanel | null>(null)
  const reportBlock = reportId != null && (
    <RunReportFullBlock reportId={reportId} onOpenEmail={setSourceEmail} />
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-team-run-detail={view.key}>
      <DetailHeader
        left={
          <>
            <RunStateBadge state={view.state} />
            <span className="min-w-0 flex-1 truncate text-body font-medium text-ink-fg">
              {run.summary?.trim() || t('team.record.runUntitled')}
            </span>
          </>
        }
        right={
          <>
            <span className="shrink-0 font-mono text-micro text-ink-fg-3">
              {fmtDateTime(view.startedMs)}
              {duration ? ` · ${duration}` : ''}
            </span>
            {reportId != null && (
              <button
                type="button"
                onClick={() => navigateToReport(navigate, reportId)}
                title={t('team.detail.report.openFromRun')}
                data-run-open-report={reportId}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-ink-border px-2.5 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
              >
                <ExternalLink size={12} strokeWidth={2} />
                {t('team.detail.report.open')}
              </button>
            )}
          </>
        }
      />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-meta text-ink-fg-3">
          {t('agents.reports.loading')}
        </div>
      ) : initialMessages.length === 0 ? (
        // run 未产生任何回复（失败/取消）——不挂 AgentThread（其空态是「新对话」欢迎屏）。
        // 🔴 --thread-max-width 只定义在 AgentThread 的 Root 上，这一支不经过它 → 必须自己
        // 定义同一个变量，否则 max-w-[var(...)] 解析失败、这支的列宽变成整幅面板。
        <div
          className="scrollbar-thin flex-1 overflow-y-auto px-4 py-4"
          style={{ ['--thread-max-width' as string]: TEAM_THREAD_MAX_WIDTH }}
        >
          {triggerBubble}
          <div className="mx-auto mb-5 w-full max-w-[var(--thread-max-width)] text-meta text-ink-fg-3">
            {run.error
              ? t('team.record.noOutputError', { error: run.error })
              : t('team.record.noOutput')}
          </div>
          {reportBlock}
        </div>
      ) : (
        <AiSdkRuntimeProvider
          key={`team-run:${view.key}`}
          gatewayBaseUrl={gatewayBaseUrl}
          sessionId={null}
          initialMessages={initialMessages}
        >
          <AgentThread
            readOnly
            maxWidth={TEAM_THREAD_MAX_WIDTH}
            headerSlot={triggerBubble}
            pendingSlot={
              <>
                <InRecordApprovalPanel
                  sessionId={view.sessionId}
                  runState={view.state}
                  agentName={agentName}
                  onDecided={onDecided}
                />
                {reportBlock}
              </>
            }
          />
        </AiSdkRuntimeProvider>
      )}
      <EmailSourcePanel email={sourceEmail} onClose={() => setSourceEmail(null)} />
    </div>
  )
}

// ─── 报告全文（run 详情内嵌，默认折叠） ─────────────────────────────────────
// 08-31 dogfood：日报 / 周报的 run 有完整 transcript，但 `out` 步骤只有 headline，看全文
// 得跳去报告页。这里把报告本体收进流末尾的折叠块 —— 渲染器直接复用报告页那一套
// （BlockRenderer + FIXED_RENDER + EmailSourcePanel），不改它们的导出。
// 🔴 展开才拉数据（`useReport(null)` 的 query 是 disabled 的）：记录列每选一条 run 都挂
// 这个块，默认折叠时不该为此多一次 report:get。
function RunReportFullBlock({
  reportId,
  onOpenEmail
}: {
  reportId: string
  onOpenEmail: (email: ReportEmailItemForPanel) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { report, isLoading } = useReport(open ? reportId : null)
  const ctx: RenderCtx = useMemo(
    () => ({ ...FIXED_RENDER, onOpenEmail, onJump: (id: number) => scrollToEmail(id) }),
    [onOpenEmail]
  )
  return (
    <div
      className="mx-auto mb-4 w-full max-w-[var(--thread-max-width)]"
      data-run-report-full={reportId}
    >
      <div className="rounded-lg border border-[var(--hairline)] bg-ink-2/60">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-meta text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={cn('shrink-0 transition-transform duration-fast', open && 'rotate-90')}
          />
          <FileChartLine size={13} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{t('team.detail.report.fullText')}</span>
        </button>
        {open && (
          <div className="border-t border-[var(--hairline)] px-3 py-3">
            {isLoading ? (
              <div className="text-meta text-ink-fg-3">{t('agents.reports.loading')}</div>
            ) : report?.doc ? (
              // 块是 LLM 生成的：一个畸形块不该把整个执行详情打白（报告页同款兜底）。
              <ErrorBoundary
                label="team-run-report-blocks"
                resetKeys={[reportId]}
                fallback={() => (
                  <div className="text-meta text-fail">{t('agents.reports.renderError')}</div>
                )}
              >
                <BlockRenderer blocks={report.doc.blocks} ctx={ctx} />
              </ErrorBoundary>
            ) : (
              <div className="text-meta text-ink-fg-3">{t('agents.reports.none')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── run（无 session）→ 统计摘要（async_jobs 行的降级形态） ─────────────────
// 08-31 起联系人画像的记录走 agent_run_log（有 transcript），不再落这里；剩下的到达者
// 是「async_jobs 行但 result_json 没留下 sessionId」的 run（如通讯录治理的老行）。
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

// ─── session → 只读 transcript ──────────────────────────────────────────────
// P4b 起只装 origin='agent' 的降级形态行（headless run 未接上台账时的会话条目）——
// untrusted trigger 历史恒只读、无 composer。origin='team' 的交互会话不进这里
//（TeamRecordPane 分流到 TeamChatHost 真 composer 续聊）。
export function TeamSessionDetail({
  session
}: {
  session: ChatSessionListItem
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

// ─── preprocess 的 labels_json 取值器 ───────────────────────────────────────
//
// 🔴 `labels_raw` 是 llm_processing.labels_json 原样解析的 dict，**运行时不保证形状**：
// 老邮件缺字段、降级路径只写半份、8000 字符截断都会出现在生产库里（实测最少的一行只有
// action_type / priority / ai_summary / category 四个键）。所以这三个取值器一律「拿不到
// 就当没有」，空的节整节不渲染 —— 绝不让 undefined 漏进 DOM。
type Labels = Record<string, unknown> | null | undefined

function labelText(raw: Labels, key: string): string | null {
  const v = raw?.[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** `key_points` 是 `\n` 分隔的**一段文本**（不是数组，schema.py:153 + 生产库实测）。行首的
 *  `•` / `-` / `1.` 是模型自己带的项目符号，剥掉后由列表统一渲染，免得叠成「• •」。 */
function labelLines(raw: Labels, key: string): string[] {
  const text = labelText(raw, key)
  if (text == null) return []
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim())
    .filter((line) => line !== '')
}

/** `mail_actions` 是字符串数组（enum 标签）。非数组 / 非字符串项一律丢。 */
function labelChips(raw: Labels, key: string): string[] {
  const v = raw?.[key]
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  return out
}

/** `recommended_actions` 是对象数组 `{id,title,detail?,confidence}`。只认带 title 的条目 ——
 *  id 是给灵动岛按钮用的机器值，不是给人读的。 */
function labelActions(raw: Labels, key: string): { title: string; detail: string | null }[] {
  const v = raw?.[key]
  if (!Array.isArray(v)) return []
  const out: { title: string; detail: string | null }[] = []
  for (const item of v) {
    if (item == null || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title.trim() : ''
    if (title === '') continue
    const detail =
      typeof rec.detail === 'string' && rec.detail.trim() !== '' ? rec.detail.trim() : null
    out.push({ title, detail })
  }
  return out
}

/** labels 一节：小写标题 + 正文。`tone` 只给判定理由用（owner 最想看的那一条）。 */
function LabelSection({
  title,
  tone,
  children
}: {
  title: string
  tone?: 'urgent'
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <div
        className={cn(
          'mb-1 text-micro font-medium tracking-wide',
          tone === 'urgent' ? 'text-urg' : 'text-ink-fg-3'
        )}
      >
        {title}
      </div>
      {children}
    </section>
  )
}

// ─── preprocess → 单封邮件的一次执行（触发 → 分类输出 → 耗时 → 错误） ───────
//
// 🔴 **不造 session、不造「一次预处理批」**：llm_processing 是 per-邮件一行，逐封记录
// 本身就是一次执行（r10 §3.4）。所以这里不走 transcript 合成，而是把那一行的字段按
// 「触发 → 输出 → 统计 → 失败原因」摆出来 —— 与项目周报详情同一种两节式。
export function TeamPreprocessDetail({ email }: { email: EnrichedEmailMeta }): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const aiQ = useQuery({
    queryKey: qk.email.ai(email.internal_id),
    queryFn: () => api.email.aiFields(email.internal_id),
    staleTime: 30_000
  })
  const ai = aiQ.data ?? null
  // 列表行的 llm_status 先用（详情还在飞时也能定调），到货后以详情为准。
  const status = ai?.llm_status ?? email.llm_status ?? null
  const failed = status === 'failed'
  const chips = [email.ai_priority, email.ai_action, email.ai_category].filter(
    (v): v is string => v != null && v !== ''
  )
  const latency = ai?.latency_ms != null ? `${(ai.latency_ms / 1000).toFixed(1)}s` : null
  // 08-31 dogfood：`aiFields` 早就把整个 labels_json 送到前端了（handlers/email.ts:684），
  // 这里原来只渲染三个 chip —— owner「只看到处理概要，看不到详细过程」。
  const raw = ai?.labels_raw
  const summary = labelText(raw, 'ai_summary')
  const urgencyReason = labelText(raw, 'urgency_reason')
  const keyPoints = labelLines(raw, 'key_points')
  const mailActions = labelChips(raw, 'mail_actions')
  const recommended = labelActions(raw, 'recommended_actions')
  const replySuggestion = labelText(raw, 'reply_suggestion_md')
  const hasLabels =
    summary != null ||
    urgencyReason != null ||
    keyPoints.length > 0 ||
    mailActions.length > 0 ||
    recommended.length > 0 ||
    replySuggestion != null
  return (
    <div
      className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4"
      data-team-preprocess-detail={email.internal_id}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-4">
        {/* 触发节：喂给它的就是这封邮件（发件人 · 时间）。 */}
        <AgentRunTriggerBubble
          triggerKind="email_filter"
          firedAtIso={email.date_received ?? null}
          detail={email.subject || String(email.internal_id)}
        />
        <div className="rounded-lg border border-[var(--hairline)] bg-ink-2/60 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                failed ? 'bg-fail' : status === 'pending' ? 'bg-info' : 'bg-ok'
              )}
            />
            <span className="text-body font-medium text-ink-fg">
              {t(failed ? 'team.preprocess.failed' : 'team.preprocess.classified')}
            </span>
          </div>
          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span
                  key={c}
                  className="rounded-md border border-ink-border bg-ink-3/60 px-2 py-0.5 text-meta text-ink-fg-1"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
          {hasLabels && (
            <div
              className="mt-3 flex flex-col gap-3 border-t border-[var(--hairline)] pt-3"
              data-preprocess-labels
            >
              {summary != null && (
                <LabelSection title={t('team.preprocess.labels.summary')}>
                  <p className="text-body leading-relaxed text-ink-fg">{summary}</p>
                </LabelSection>
              )}
              {urgencyReason != null && (
                <LabelSection title={t('team.preprocess.labels.urgencyReason')} tone="urgent">
                  <p className="text-body leading-relaxed text-ink-fg">{urgencyReason}</p>
                </LabelSection>
              )}
              {keyPoints.length > 0 && (
                <LabelSection title={t('team.preprocess.labels.keyPoints')}>
                  <ul className="flex flex-col gap-1">
                    {keyPoints.map((point, i) => (
                      <li key={i} className="flex gap-2 text-aux leading-relaxed text-ink-fg-1">
                        <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-ink-fg-3" />
                        <span className="min-w-0">{point}</span>
                      </li>
                    ))}
                  </ul>
                </LabelSection>
              )}
              {mailActions.length > 0 && (
                <LabelSection title={t('team.preprocess.labels.mailActions')}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {mailActions.map((a) => (
                      <span
                        key={a}
                        className="rounded-md border border-ink-border bg-ink-3/60 px-2 py-0.5 text-meta text-ink-fg-1"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </LabelSection>
              )}
              {recommended.length > 0 && (
                <LabelSection title={t('team.preprocess.labels.recommendedActions')}>
                  <ul className="flex flex-col gap-1">
                    {recommended.map((a, i) => (
                      <li key={i} className="text-aux leading-relaxed text-ink-fg-1">
                        <span className="text-ink-fg">{a.title}</span>
                        {a.detail != null && <span className="text-ink-fg-3"> · {a.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </LabelSection>
              )}
              {replySuggestion != null && (
                <LabelSection title={t('team.preprocess.labels.replySuggestion')}>
                  {/* 模型写的是 inline-only markdown（schema.py:224）——不引渲染器，原样
                      pre-wrap 呈现即可，这一处是「看它当时写了什么」而不是编辑面。 */}
                  <pre className="whitespace-pre-wrap font-sans text-aux leading-relaxed text-ink-fg-1 [overflow-wrap:anywhere]">
                    {replySuggestion}
                  </pre>
                </LabelSection>
              )}
            </div>
          )}
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta text-ink-fg-2">
            {ai?.ai_model && (
              <>
                <dt className="text-ink-fg-3">{t('team.detail.model')}</dt>
                <dd className="font-mono">{ai.ai_model}</dd>
              </>
            )}
            {latency && (
              <>
                <dt className="text-ink-fg-3">{t('team.detail.duration')}</dt>
                <dd className="font-mono">{latency}</dd>
              </>
            )}
            {ai?.input_tokens != null && ai?.output_tokens != null && (
              <>
                <dt className="text-ink-fg-3">{t('team.detail.tokens')}</dt>
                <dd className="font-mono">
                  {t('team.detail.tokensInOut', {
                    input: ai.input_tokens,
                    output: ai.output_tokens
                  })}
                </dd>
              </>
            )}
            {ai?.retry_count != null && ai.retry_count > 0 && (
              <>
                <dt className="text-ink-fg-3">{t('team.preprocess.retries')}</dt>
                <dd className="font-mono">{ai.retry_count}</dd>
              </>
            )}
          </dl>
          {failed && (
            <div className="mt-2.5 rounded-md border border-fail/25 bg-fail/10 px-3 py-2 text-meta leading-relaxed text-ink-fg-1">
              {ai?.last_error && (
                <p className="font-mono text-fail [overflow-wrap:anywhere]">{ai.last_error}</p>
              )}
              {/* prd：失败案例写出为什么这么处置，不是只写「失败」。 */}
              <p className="mt-1 text-ink-fg-2">{t('team.preprocess.failNote')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
