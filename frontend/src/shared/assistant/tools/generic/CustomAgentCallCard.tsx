import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  OctagonX,
  Square,
  XCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AgentRunState, ReportAgentConfig } from '@shared/api/types'
import { AgentAvatar } from '@shared/components/agents/AgentAvatar'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import {
  projectAgentCallState,
  type AgentCallProjectedState
} from '@shared/lib/agentCallState'
import { errorMessage } from '@shared/lib/ipcErrors'
import { resolveAiGatewayBaseUrl } from '../../runtime/flags'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

const POLL_MS = 3_000

interface AgentCallArgs {
  agent_id?: string
  instruction?: string
  context_note?: string
  source_session_id?: number
  email_internal_ids?: number[]
  email_thread_ids?: string[]
  calendar_event_ids?: string[]
  notion_refs?: Array<{ connector_id?: string; object_id?: string; object_type?: string }>
  report_ids?: string[]
}

interface AgentCallReference {
  type: string
  id: string | number
  title?: string
}

interface AgentCallView {
  agentId: string
  agentTitle: string
  jobId: number
  sessionId: number
  status: AgentCallProjectedState['status']
  summary?: string
  finalAnswer?: string
  truncated?: boolean
  references?: AgentCallReference[]
  durationMs?: number
  usage?: Record<string, number | null>
  error?: { code: string; message: string }
}

interface AgentRunPoll {
  jobId: number
  agentId: string
  agentTitle?: string
  state: AgentRunState
  outcome?: string | null
  summary?: string | null
  sessionId?: number | null
  error?: string | null
  finalAnswer?: string | null
  finalAnswerTruncated?: boolean
  durationSeconds?: number | null
  tokens?: Record<string, number | null> | null
}

function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') return env.VITE_API_BASE_URL ?? '/api'
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const parsed = raw == null ? NaN : Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) port = parsed
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseArgs(value: unknown): AgentCallArgs {
  return (asRecord(value) ?? {}) as AgentCallArgs
}

function parseResult(value: unknown, args: AgentCallArgs): AgentCallView | null {
  const row = asRecord(value)
  if (!row || typeof row.status !== 'string') return null
  if (
    typeof row.agent_id !== 'string' ||
    typeof row.job_id !== 'number' ||
    typeof row.session_id !== 'number'
  ) {
    return null
  }
  const status = row.status as AgentCallView['status']
  if (!['queued', 'running', 'waiting_approval', 'completed', 'failed', 'stopped'].includes(status)) {
    return null
  }
  const error = asRecord(row.error)
  return {
    agentId: row.agent_id,
    agentTitle: typeof row.agent_title === 'string' ? row.agent_title : row.agent_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    status,
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    ...(typeof row.final_answer === 'string' ? { finalAnswer: row.final_answer } : {}),
    ...(row.truncated === true ? { truncated: true } : {}),
    ...(Array.isArray(row.references)
      ? { references: row.references as AgentCallReference[] }
      : { references: inputReferences(args, row.session_id) }),
    ...(typeof row.duration_ms === 'number' ? { durationMs: row.duration_ms } : {}),
    ...(asRecord(row.usage) ? { usage: row.usage as Record<string, number | null> } : {}),
    ...(error && typeof error.code === 'string' && typeof error.message === 'string'
      ? { error: { code: error.code, message: error.message } }
      : {})
  }
}

function inputReferences(args: AgentCallArgs, sessionId?: number): AgentCallReference[] {
  const refs: AgentCallReference[] = []
  if (typeof args.source_session_id === 'number') refs.push({ type: 'session', id: args.source_session_id })
  for (const id of args.email_internal_ids ?? []) refs.push({ type: 'email', id })
  for (const id of args.email_thread_ids ?? []) refs.push({ type: 'email', id })
  for (const id of args.calendar_event_ids ?? []) refs.push({ type: 'calendar', id })
  for (const ref of args.notion_refs ?? []) {
    if (typeof ref.object_id === 'string') refs.push({ type: 'notion', id: ref.object_id })
  }
  for (const id of args.report_ids ?? []) refs.push({ type: 'report', id })
  if (sessionId != null && !refs.some((ref) => ref.type === 'session' && ref.id === sessionId)) {
    refs.push({ type: 'session', id: sessionId })
  }
  return refs
}

function contextRefCount(args: AgentCallArgs): number {
  return inputReferences(args).length
}

async function fetchAgent(agentId: string): Promise<ReportAgentConfig> {
  const response = await fetch(
    `${resolveApiBaseUrl()}/report-agents?agentId=${encodeURIComponent(agentId)}`,
    { credentials: 'include' }
  )
  if (!response.ok) throw new Error(`E_HTTP_${response.status}`)
  const body = (await response.json()) as { status?: string; data?: ReportAgentConfig }
  if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
  return body.data
}

function projectedView(run: AgentRunPoll, previous: AgentCallView): AgentCallView {
  const projected = projectAgentCallState({
    state: run.state,
    lastError: run.error,
    outcome: run.outcome
  })
  return {
    ...previous,
    agentId: run.agentId,
    agentTitle: run.agentTitle || previous.agentTitle,
    sessionId: typeof run.sessionId === 'number' ? run.sessionId : previous.sessionId,
    status: projected.status,
    ...(run.summary ? { summary: run.summary } : {}),
    ...(typeof run.finalAnswer === 'string' ? { finalAnswer: run.finalAnswer } : {}),
    ...(run.finalAnswerTruncated === true ? { truncated: true } : {}),
    ...(typeof run.durationSeconds === 'number'
      ? { durationMs: Math.round(run.durationSeconds * 1000) }
      : {}),
    ...(run.tokens ? { usage: run.tokens } : {}),
    ...(projected.status === 'failed' || projected.status === 'stopped'
      ? { error: projected.error }
      : {})
  }
}

function statusIcon(status: AgentCallView['status']): React.ReactNode {
  if (status === 'completed') return <CheckCircle2 size={15} />
  if (status === 'failed') return <OctagonX size={15} />
  if (status === 'stopped') return <XCircle size={15} />
  if (status === 'waiting_approval') return <Clock3 size={15} />
  return <CircleDashed size={15} className="animate-spin motion-reduce:animate-none" />
}

export function CustomAgentCallCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const phase = deriveCardPhase(props)
  const args = useMemo(() => parseArgs(props.args), [props.args])
  const [facts, setFacts] = useState<ReportAgentConfig | null>(null)
  const [factsError, setFactsError] = useState<string | null>(null)
  const [view, setView] = useState<AgentCallView | null>(() => parseResult(props.result, args))
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    setView(parseResult(props.result, args))
  }, [props.result, args])

  useEffect(() => {
    if (!args.agent_id) return
    let cancelled = false
    fetchAgent(args.agent_id)
      .then((row) => {
        if (!cancelled) setFacts(row)
      })
      .catch((error) => {
        if (!cancelled) setFactsError(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [phase, args.agent_id])

  const refreshRun = useCallback(async (): Promise<void> => {
    if (!view) return
    const response = await fetch(`${resolveApiBaseUrl()}/agent-runs/${view.jobId}`, {
      credentials: 'include'
    })
    if (!response.ok) throw new Error(`E_HTTP_${response.status}`)
    const body = (await response.json()) as { status?: string; data?: AgentRunPoll }
    if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
    setView((current) => (current ? projectedView(body.data as AgentRunPoll, current) : current))
  }, [view?.jobId])

  useEffect(() => {
    if (!view || !['queued', 'running', 'waiting_approval'].includes(view.status)) return
    let cancelled = false
    const poll = (): void => {
      void refreshRun().catch((error) => {
        if (!cancelled) setActionError(errorMessage(error))
      })
    }
    const timer = window.setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [view?.status, view?.jobId, refreshRun])

  const openSession = (): void => {
    if (!view) return
    requestOpenAgentSession(view.sessionId)
    void navigate({ to: '/sessions' })
  }

  const stopOrCancel = async (): Promise<void> => {
    if (!view || (view.status !== 'queued' && view.status !== 'running')) return
    setActionBusy(true)
    setActionError(null)
    try {
      if (view.status === 'queued') {
        const response = await fetch(`${resolveApiBaseUrl()}/agent-runs/${view.jobId}/cancel`, {
          method: 'POST',
          credentials: 'include'
        })
        if (!response.ok) throw new Error(`E_HTTP_${response.status}`)
      } else {
        const gateway = resolveAiGatewayBaseUrl()
        if (gateway == null) throw new Error('E_NO_GATEWAY')
        const response = await fetch(`${gateway}/api/ai/run/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: view.sessionId })
        })
        if (!response.ok) throw new Error(`E_HTTP_${response.status}`)
      }
      await refreshRun()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setActionBusy(false)
    }
  }

  if (phase === 'pending') {
    const policy = facts?.tool_policy
    const riskItems = [
      policy?.grant_exec === true ? t('chat.agentCallCard.risk.exec') : null,
      policy?.grant_web && policy.grant_web !== 'off'
        ? t('chat.agentCallCard.risk.web', { level: policy.grant_web })
        : null,
      policy?.grant_connectors && Object.keys(policy.grant_connectors).length > 0
        ? t('chat.agentCallCard.risk.connectors', {
            count: Object.keys(policy.grant_connectors).length
          })
        : null,
      Array.isArray(policy?.allowed_tools) && policy.allowed_tools.length > 0
        ? t('chat.agentCallCard.risk.tools', { count: policy.allowed_tools.length })
        : null
    ].filter((item): item is string => item != null)
    return (
      <CardFrame
        icon={
          <AgentAvatar
            agentId={args.agent_id ?? 'unknown-agent'}
            config={facts?.avatar}
            size={16}
          />
        }
        title={t('chat.agentCallCard.approvalTitle')}
        phase={phase}
      >
        <div className="space-y-2">
          <div>
            <p className="text-aux font-medium text-ink-fg">
              {facts?.title || args.agent_id || t('chat.agentCallCard.unknownAgent')}
            </p>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-meta text-ink-fg-2">
              {args.instruction || t('chat.agentCallCard.noInstruction')}
            </p>
          </div>
          <div className="rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2 text-meta text-ink-fg-2">
            <p>{t('chat.agentCallCard.contextCount', { count: contextRefCount(args) })}</p>
            <p className="mt-1 font-medium text-ink-fg">
              {facts == null && factsError == null
                ? t('chat.agentCallCard.risk.loading')
                : factsError
                  ? t('chat.agentCallCard.risk.unavailable')
                  : riskItems.length > 0
                    ? riskItems.join(' · ')
                    : t('chat.agentCallCard.risk.readonly')}
            </p>
          </div>
          <ApprovalActions
            onApprove={() => props.respondToApproval?.({ approved: true })}
            onReject={() => props.respondToApproval?.({ approved: false })}
            approveLabel={t('chat.agentCallCard.approve')}
          />
        </div>
      </CardFrame>
    )
  }

  if (phase === 'rejected' || phase === 'expired' || phase === 'error') {
    return (
      <CardFrame
        icon={
          <AgentAvatar
            agentId={args.agent_id ?? 'unknown-agent'}
            config={facts?.avatar}
            size={16}
          />
        }
        title={t('chat.agentCallCard.title')}
        phase={phase}
      >
        <TerminalBanner phase={phase} />
      </CardFrame>
    )
  }

  if (!view) {
    return (
      <section className="my-1.5 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 px-3 py-2.5">
        <p className="text-aux font-medium text-ink-fg">{t('chat.agentCallCard.title')}</p>
        <p className="mt-1 text-meta text-ink-fg-3">{t('chat.agentCallCard.invalid')}</p>
      </section>
    )
  }

  const refs = view.references ?? inputReferences(args, view.sessionId)
  const terminal = ['completed', 'failed', 'stopped'].includes(view.status)
  return (
    <section
      className="my-1.5 min-w-0 overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1"
      aria-label={t('chat.agentCallCard.title')}
    >
      <div className="flex items-center gap-2 border-b border-ink-border-soft px-3 py-2">
        <AgentAvatar agentId={view.agentId} config={facts?.avatar} size={20} />
        <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">
          {view.agentTitle}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-ink-2 px-2 py-0.5 text-meta font-medium text-ink-fg-2">
          {statusIcon(view.status)}
          {t(`chat.agentCallCard.status.${view.status}`)}
        </span>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        {(view.status === 'queued' || view.status === 'running') && (
          <p className="text-aux text-ink-fg-2">
            {view.summary || t(`chat.agentCallCard.${view.status}Hint`)}
          </p>
        )}
        {view.status === 'waiting_approval' && (
          <div className="rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2 text-aux text-ink-fg">
            {t('chat.agentCallCard.waitingHint')}
          </div>
        )}
        {view.status === 'completed' && (
          <div>
            <p className="whitespace-pre-wrap text-aux leading-relaxed text-ink-fg">
              {view.finalAnswer || view.summary || t('chat.agentCallCard.emptyAnswer')}
            </p>
            {view.truncated && (
              <p className="mt-1 text-meta text-warn">{t('chat.agentCallCard.truncated')}</p>
            )}
            {typeof view.durationMs === 'number' && (
              <p className="mt-1 text-meta text-ink-fg-3">
                {t('chat.agentCallCard.duration', {
                  seconds: Math.max(0, Math.round(view.durationMs / 1000))
                })}
              </p>
            )}
          </div>
        )}
        {(view.status === 'failed' || view.status === 'stopped') && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-aux text-danger">
            <p className="font-mono text-meta">{view.error?.code || 'E_UNKNOWN'}</p>
            <p className="mt-1">{view.error?.message || t('chat.agentCallCard.unknownError')}</p>
          </div>
        )}
        {view.status === 'completed' && refs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {refs.map((ref, index) => (
              <span
                key={`${ref.type}:${String(ref.id)}:${index}`}
                className="rounded-full border border-ink-border-soft bg-ink-2 px-2 py-0.5 text-meta text-ink-fg-2"
              >
                {ref.title || `${ref.type}:${String(ref.id)}`}
              </span>
            ))}
          </div>
        )}
        {actionError && <p className="text-meta text-danger">{actionError}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-border-soft pt-2">
          <button
            type="button"
            onClick={openSession}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3"
          >
            <ExternalLink size={12} />
            {t('chat.agentCallCard.openSession')}
          </button>
          {!terminal && (view.status === 'queued' || view.status === 'running') && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void stopOrCancel()}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2.5 text-aux text-danger transition-opacity duration-fast hover:opacity-80 disabled:opacity-40"
            >
              <Square size={11} fill="currentColor" />
              {t(view.status === 'queued' ? 'chat.agentCallCard.cancel' : 'chat.agentCallCard.stop')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
