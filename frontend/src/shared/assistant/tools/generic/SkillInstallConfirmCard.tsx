// S2 W4 — SkillInstallConfirmCard (skill_install_confirm, edit tier + capability_change).
//
// 🔴 SERVER-FACT rendering (ADR-002 §4): stage TWO of the install decides "install exactly these
// files". The card does NOT trust the model's args content fields — it fetches the quarantine
// facts live from serve-api GET /agent/skills/quarantine/{qid}, which RE-HASHES the on-disk
// quarantine content, so what the user reviews (name / version / package hash / file list /
// declared secrets / SKILL.md excerpt) is the disk truth at render time, and the confirm endpoint
// re-hashes AGAIN at execute time (TOCTOU guard, 409 on drift). A model lying about package
// contents in its tool args changes nothing here.
//
// Facts unavailable (endpoint error / quarantine gone) → the card says so and only offers 拒绝
// (approving an install you cannot review is never on the table).

import { useEffect, useState } from 'react'
import { PackageCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillInstallConfirmCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'
import { errorMessage } from '@shared/lib/ipcErrors'

// Resolve serve-api base URL for direct fetch calls (mirrors CustomAiSection.resolveApiBaseUrl;
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

/** The server-verified quarantine facts (GET /agent/skills/quarantine/{qid} data block). */
interface QuarantineFacts {
  quarantineId: string
  sourceUri: string | null
  packageHash: string
  files: Record<string, string>
  manifest: {
    name: string | null
    type: string | null
    version: string | null
    title: string | null
    description: string | null
    entryHint: string | null
  }
  secretNames: string[]
  skillMdExcerpt: string
}

async function fetchQuarantineFacts(qid: string): Promise<QuarantineFacts> {
  const resp = await fetch(
    `${resolveApiBaseUrl()}/agent/skills/quarantine/${encodeURIComponent(qid)}`,
    { credentials: 'include' }
  )
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as { status?: string; data?: QuarantineFacts }
  if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
  return body.data
}

function propsOf(toolName: string, args: unknown, result: unknown): SkillInstallConfirmCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? { quarantineId: '' }) as unknown as SkillInstallConfirmCardProps
}

const EXCERPT_CAP = 600
const FILE_LIST_CAP = 8

export function SkillInstallConfirmCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const [facts, setFacts] = useState<QuarantineFacts | null>(null)
  const [factsError, setFactsError] = useState<string | null>(null)

  const qid = data.quarantineId

  useEffect(() => {
    if (phase !== 'pending' || !qid) return
    let cancelled = false
    fetchQuarantineFacts(qid)
      .then((f) => {
        if (!cancelled) setFacts(f)
      })
      .catch((e) => {
        if (!cancelled) setFactsError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [phase, qid])

  const fileNames = facts ? Object.keys(facts.files) : []

  return (
    <CardFrame
      icon={<PackageCheck size={13} strokeWidth={2} />}
      title={t('chat.skillInstallConfirmCard.title')}
      phase={phase}
    >
      {phase === 'pending' ? (
        factsError || !qid ? (
          <>
            <div className="text-aux text-fail">
              {t('chat.skillInstallConfirmCard.factsError', {
                detail: qid ? factsError : t('chat.skillInstallConfirmCard.missingQid')
              })}
            </div>
            <div className="mt-2.5 flex items-center justify-end">
              <button
                type="button"
                onClick={() => respondToApproval({ approved: false })}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3"
              >
                <X size={12} strokeWidth={2.5} />
                {t('chat.skillInstallConfirmCard.reject')}
              </button>
            </div>
          </>
        ) : !facts ? (
          <div className="text-aux text-ink-fg-3">
            {t('chat.skillInstallConfirmCard.verifying')}
          </div>
        ) : (
          <>
            <div className="text-aux text-ink-fg-2">{t('chat.skillInstallConfirmCard.lead')}</div>
            <div className="mt-1.5 space-y-0.5">
              <div className="text-aux text-ink-fg">
                <span className="font-medium">
                  {facts.manifest.name ?? t('chat.skillInstallConfirmCard.unnamed')}
                </span>
                {facts.manifest.version ? (
                  <span className="text-ink-fg-3">{`  v${facts.manifest.version}`}</span>
                ) : null}
                {facts.manifest.title ? (
                  <span className="text-ink-fg-2">{` · ${facts.manifest.title}`}</span>
                ) : null}
              </div>
              {facts.manifest.description ? (
                <div className="text-aux text-ink-fg-3">{facts.manifest.description}</div>
              ) : null}
              <div className="break-all font-mono text-meta text-ink-fg-3">
                {t('chat.skillInstallConfirmCard.packageHash', {
                  hash: facts.packageHash.slice(0, 16),
                  count: fileNames.length
                })}
              </div>
            </div>
            <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1.5">
              <div className="font-mono text-meta text-ink-fg-2">
                {fileNames.slice(0, FILE_LIST_CAP).join('  ')}
                {fileNames.length > FILE_LIST_CAP
                  ? t('chat.skillInstallConfirmCard.moreFiles', { count: fileNames.length })
                  : ''}
              </div>
            </div>
            {facts.secretNames.length > 0 ? (
              <div className="mt-1.5 text-aux text-ink-fg-2">
                {t('chat.skillInstallConfirmCard.secretsDeclared')}
                <span className="font-mono text-meta">{` ${facts.secretNames.join(' / ')}`}</span>
              </div>
            ) : null}
            {facts.skillMdExcerpt ? (
              <div className="mt-1.5 max-h-28 overflow-y-auto rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1.5 text-meta text-ink-fg-3">
                {facts.skillMdExcerpt.slice(0, EXCERPT_CAP)}
                {facts.skillMdExcerpt.length > EXCERPT_CAP ? ' …' : ''}
              </div>
            ) : null}
            <div className="mt-2 text-aux text-ink-fg-3">
              {t('chat.skillInstallConfirmCard.postInstallNote')}
            </div>
            <ApprovalActions
              onApprove={() => respondToApproval({ approved: true })}
              onReject={(reason) => respondToApproval({ approved: false, reason })}
              approveLabel={t('chat.skillInstallConfirmCard.approve')}
              rejectReason
            />
          </>
        )
      ) : phase === 'done' ? (
        <div className="text-aux text-ink-fg-2">
          {data.installed
            ? t('chat.skillInstallConfirmCard.installed', { name: data.installedName ?? qid })
            : t('chat.skillInstallConfirmCard.installExecuted', {
                name: data.installedName ?? qid
              })}
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.skillInstallConfirmCard.error')}</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{qid}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
