// S6 W3-2 (ADR-004 rev3.1 §7 D5 / D-fix-2) — CustomAgentApprovalCard
// (custom_agent_create / custom_agent_update, edit tier + class capability_change).
//
// The mandatory approval card for the conversational agent CRUD. It surfaces the PERMISSION
// summary the generic shell buried in raw JSON: name / purpose / requested grants, with
// grant_exec and grant_web='open' in the high-risk red treatment (SystemDocApprovalCard
// precedent).
//
// 🔴 SERVER-FACT before-diff (D-fix-2, SkillInstallConfirmCard precedent): update is a partial
//    patch — echoing only the submitted fields would let a permission escalation hide. The card
//    fetches the agent's CURRENT row live from serve-api (GET /api/report-agents?agentId=...) and
//    renders before→after for every permission axis; "before" NEVER comes from the model's args
//    (the A2UI payload carries only the patch), so a model lying about current permissions
//    changes nothing. Escalations (exec off→on, web off→gated/open or gated→open, newly mounted
//    skills) are red per item.
//
// Facts unavailable while the patch touches permissions → reject-only (approving a permission
// change you cannot baseline is never on the table — mirrors the install-confirm fail-closed
// stance); a facts miss on a non-permission patch degrades to a warning (the patch itself is
// fully shown).

import { useEffect, useState } from 'react'
import { Bot, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import type { ReportAgentConfig } from '@shared/api/types'
import { buildToolA2UIPayload, type CustomAgentApprovalCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'
import { errorMessage } from '@shared/lib/ipcErrors'

// Resolve serve-api base URL for direct fetch calls (mirrors SkillInstallConfirmCard —
// intentionally duplicated to avoid coupling a shared tool card to the settings module).
function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

async function fetchAgentRow(agentId: string): Promise<ReportAgentConfig> {
  const resp = await fetch(
    `${resolveApiBaseUrl()}/report-agents?agentId=${encodeURIComponent(agentId)}`,
    { credentials: 'include' }
  )
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as { status?: string; data?: ReportAgentConfig }
  if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
  return body.data
}

type WebGrant = 'off' | 'gated' | 'open'

/** One permission axis snapshot. skills null = not configured (server default mount set). */
interface PermState {
  exec: boolean
  web: WebGrant
  skills: string[] | null
}

/** Presentational mirror of the backend DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS (agent_runs.py) —
 *  used ONLY to label the default mount set and to red-mark newly mounted skills; the
 *  enforcement authority stays Python-side. */
const DEFAULT_MOUNTED_SKILLS = ['email', 'search'] as const

const WEB_RANK: Record<WebGrant, number> = { off: 0, gated: 1, open: 2 }

function permsOfRow(row: ReportAgentConfig | null): PermState {
  const tp = row?.tool_policy
  const web = tp?.grant_web
  return {
    exec: tp?.grant_exec === true,
    web: web === 'gated' || web === 'open' ? web : 'off',
    skills: Array.isArray(tp?.skills) ? tp.skills : null
  }
}

function propsOf(toolName: string, args: unknown, result: unknown): CustomAgentApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    kind: 'create',
    agentId: ''
  }) as unknown as CustomAgentApprovalCardProps
}

export function CustomAgentApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const isUpdate = data.kind === 'update'
  const [facts, setFacts] = useState<ReportAgentConfig | null>(null)
  const [factsError, setFactsError] = useState<string | null>(null)

  const touchesPerms =
    data.grantExec !== undefined || data.grantWeb !== undefined || data.skills !== undefined

  useEffect(() => {
    if (phase !== 'pending' || !isUpdate || !data.agentId) return
    let cancelled = false
    fetchAgentRow(data.agentId)
      .then((row) => {
        if (!cancelled) setFacts(row)
      })
      .catch((e) => {
        if (!cancelled) setFactsError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [phase, isUpdate, data.agentId])

  const webLabel = (g: WebGrant): string => t(`chat.customAgentCard.web.${g}`)
  const onOffLabel = (on: boolean): string =>
    t(on ? 'chat.customAgentCard.grantOn' : 'chat.customAgentCard.grantOff')
  const skillsLabel = (skills: string[] | null): string =>
    skills === null
      ? t('chat.customAgentCard.skillsDefault')
      : skills.length === 0
        ? t('chat.customAgentCard.skillsNone')
        : skills.join('、')

  /** Effective mount set for escalation marking (null → the default mounts, mirror constant). */
  const effectiveSkills = (skills: string[] | null): readonly string[] =>
    skills === null ? DEFAULT_MOUNTED_SKILLS : skills

  const title = t(
    isUpdate ? 'chat.customAgentCard.titleUpdate' : 'chat.customAgentCard.titleCreate'
  )

  // ── permission model: create diffs against the safe defaults; update against the SERVER row ──
  const before: PermState = isUpdate ? permsOfRow(facts) : { exec: false, web: 'off', skills: null }
  const after: PermState = {
    exec: data.grantExec ?? before.exec,
    web: data.grantWeb ?? before.web,
    skills: data.skills !== undefined ? data.skills : before.skills
  }
  const execEscalated = !before.exec && after.exec
  const webEscalated = WEB_RANK[after.web] > WEB_RANK[before.web]
  const newSkills = effectiveSkills(after.skills).filter(
    (s) => !effectiveSkills(before.skills).includes(s)
  )

  const permRow = (
    label: string,
    beforeText: string,
    afterText: string,
    changed: boolean,
    escalated: boolean
  ): React.JSX.Element => (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-aux text-ink-fg-3">{label}</span>
      {isUpdate && changed ? (
        <span className="text-aux">
          <span className="text-ink-fg-3 line-through">{beforeText}</span>
          <span className="text-ink-fg-3">{' → '}</span>
          <span className={escalated ? 'font-medium text-fail' : 'text-ink-fg'}>{afterText}</span>
        </span>
      ) : (
        <span className={escalated ? 'font-medium text-fail' : 'text-aux text-ink-fg'}>
          {afterText}
        </span>
      )}
    </div>
  )

  // update + permission patch + no server baseline → reject-only (fail-closed review floor)
  const permsUnreviewable = isUpdate && touchesPerms && factsError != null

  if (phase === 'pending') {
    return (
      <CardFrame icon={<Bot size={13} strokeWidth={2} />} title={title} phase={phase}>
        <div className="text-aux text-ink-fg-2">
          {isUpdate
            ? t('chat.customAgentCard.leadUpdate', { id: data.agentId })
            : t('chat.customAgentCard.leadCreate')}
        </div>

        {/* identity / spec summary (the model's proposal) */}
        <div className="mt-1.5 space-y-0.5">
          {(data.title !== undefined || !isUpdate) && (
            <div className="text-aux text-ink-fg">
              <span className="text-ink-fg-3">{`${t('chat.customAgentCard.name')}：`}</span>
              <span className="font-medium">{data.title ?? data.agentId}</span>
              {!isUpdate && (
                <span className="font-mono text-meta text-ink-fg-3">{`  ${data.agentId}`}</span>
              )}
            </div>
          )}
          {data.model !== undefined && (
            <div className="text-aux text-ink-fg-2">
              <span className="text-ink-fg-3">{`${t('chat.customAgentCard.model')}：`}</span>
              {data.model}
            </div>
          )}
          {data.enabled !== undefined && (
            <div className="text-aux text-ink-fg-2">
              <span className="text-ink-fg-3">{`${t('chat.customAgentCard.enabled')}：`}</span>
              {onOffLabel(data.enabled)}
            </div>
          )}
          {data.triggerSummary !== undefined && (
            <div className="text-aux text-ink-fg-2">
              <span className="text-ink-fg-3">{`${t('chat.customAgentCard.trigger')}：`}</span>
              {data.triggerSummary === null ? (
                t('chat.customAgentCard.triggerCleared')
              ) : (
                <span className="font-mono text-meta">{data.triggerSummary}</span>
              )}
            </div>
          )}
          {data.allowedTools !== undefined && (
            <div className="text-aux text-ink-fg-2">
              <span className="text-ink-fg-3">{`${t('chat.customAgentCard.allowedTools')}：`}</span>
              <span className="font-mono text-meta">
                {data.allowedTools.length > 0 ? data.allowedTools.join(' ') : '[]'}
              </span>
            </div>
          )}
        </div>

        {/* purpose (steering prompt) — full text, scrollable; never truncated (review surface) */}
        {data.prompt !== undefined && data.prompt !== null && data.prompt !== '' && (
          <>
            <div className="mt-1.5 text-aux text-ink-fg-3">{`${t('chat.customAgentCard.purpose')}：`}</div>
            <div className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1.5 text-meta text-ink-fg-2">
              {data.prompt}
            </div>
          </>
        )}

        {/* ── permission summary（恒渲染，update 为服务端 before → after diff）── */}
        <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2">
          <div className="mb-1 text-aux font-medium text-ink-fg">
            {t('chat.customAgentCard.permissions')}
          </div>
          {isUpdate && facts == null && factsError == null ? (
            <div className="text-aux text-ink-fg-3">{t('chat.customAgentCard.factsLoading')}</div>
          ) : permsUnreviewable ? (
            <div className="text-aux text-fail">
              {t('chat.customAgentCard.factsError', { err: factsError })}
            </div>
          ) : (
            <div className="space-y-1">
              {isUpdate && factsError != null && (
                <div className="text-aux text-ink-fg-3">
                  {t('chat.customAgentCard.factsErrorSoft', { err: factsError })}
                </div>
              )}
              {permRow(
                t('chat.customAgentCard.grantExec'),
                onOffLabel(before.exec),
                onOffLabel(after.exec),
                before.exec !== after.exec,
                execEscalated || (!isUpdate && after.exec)
              )}
              {permRow(
                t('chat.customAgentCard.grantWeb'),
                webLabel(before.web),
                webLabel(after.web),
                before.web !== after.web,
                (webEscalated || !isUpdate) && after.web === 'open'
              )}
              {permRow(
                t('chat.customAgentCard.skills'),
                skillsLabel(before.skills),
                skillsLabel(after.skills),
                skillsLabel(before.skills) !== skillsLabel(after.skills),
                false
              )}
              {isUpdate && newSkills.length > 0 && (
                <div className="text-aux text-fail">
                  {t('chat.customAgentCard.newSkills', { skills: newSkills.join('、') })}
                </div>
              )}
              {after.exec && (execEscalated || !isUpdate) && (
                <div className="text-aux text-fail">{t('chat.customAgentCard.execWarn')}</div>
              )}
              {after.web === 'open' && (webEscalated || !isUpdate) && (
                <div className="text-aux text-fail">{t('chat.customAgentCard.webOpenWarn')}</div>
              )}
              {after.web === 'gated' && (webEscalated || !isUpdate) && (
                <div className="text-aux text-ink-fg-3">
                  {t('chat.customAgentCard.webGatedNote')}
                </div>
              )}
            </div>
          )}
        </div>

        {permsUnreviewable ? (
          <div className="mt-2.5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => respondToApproval({ approved: false })}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3"
            >
              <X size={12} strokeWidth={2.5} />
              {t('chat.customAgentCard.reject')}
            </button>
          </div>
        ) : (
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel={t(
              isUpdate ? 'chat.customAgentCard.approveUpdate' : 'chat.customAgentCard.approveCreate'
            )}
            // update: no approving before the server baseline arrives — the diff being reviewed
            // must be the real one (facts error paths are handled above / by permsUnreviewable).
            disabled={isUpdate && facts == null && factsError == null}
          />
        )}
      </CardFrame>
    )
  }

  return (
    <CardFrame icon={<Bot size={13} strokeWidth={2} />} title={title} phase={phase}>
      {phase === 'done' ? (
        <div className="text-aux text-ink-fg-2">
          {t(isUpdate ? 'chat.customAgentCard.updatedDone' : 'chat.customAgentCard.createdDone', {
            id: data.title ?? data.agentId
          })}
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.customAgentCard.failed')}</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{data.agentId}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
