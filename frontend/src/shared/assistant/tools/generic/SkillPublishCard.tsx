import { useEffect, useState } from 'react'
import { PackageCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') return env.VITE_API_BASE_URL ?? '/api'
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const parsed = raw == null ? NaN : Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) port = parsed
  } catch {
    // test/non-renderer environment
  }
  return `http://127.0.0.1:${port}/api`
}

interface DraftFacts {
  name: string
  files: Array<{ path: string; bytes: number }>
  validation: {
    package_hash?: string | null
    scripts?: Record<string, unknown>
    tests?: Record<string, boolean>
  } | null
  replacesInstalled?: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function SkillPublishCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const input = asRecord(props.args)
  const draftId = typeof input.draftId === 'string' ? input.draftId : ''
  const enabled = input.enabled !== false
  const [facts, setFacts] = useState<DraftFacts | null>(null)
  const [factsError, setFactsError] = useState(false)

  useEffect(() => {
    if (phase !== 'pending' || !draftId) return
    let cancelled = false
    fetch(`${resolveApiBaseUrl()}/agent/skills/drafts/${encodeURIComponent(draftId)}`, {
      credentials: 'include'
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        const payload = (await response.json()) as { status?: string; data?: DraftFacts }
        if (payload.status !== 'success' || !payload.data) throw new Error('bad envelope')
        if (!cancelled) setFacts(payload.data)
      })
      .catch(() => {
        if (!cancelled) setFactsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [draftId, phase])

  return (
    <CardFrame icon={<PackageCheck size={13} />} title={t('chat.skillPublishCard.title')} phase={phase}>
      {phase === 'pending' ? (
        factsError || !draftId ? (
          <div className="space-y-2">
            <div className="text-aux text-fail">{t('chat.skillPublishCard.factsError')}</div>
            <button type="button" onClick={() => props.respondToApproval({ approved: false })}>
              <X size={12} />
            </button>
          </div>
        ) : facts ? (
          <div className="space-y-2 text-aux text-ink-fg-2">
            <div className="font-medium text-ink-fg">
              {facts.name} · {facts.validation?.package_hash?.slice(0, 12) ?? '—'}
            </div>
            <div>{t('chat.skillPublishCard.files', { count: facts.files.length })}</div>
            <div className="break-all font-mono text-meta">{facts.files.map((file) => file.path).join('  ')}</div>
            <div>{t('chat.skillPublishCard.enabled', { value: enabled ? 'yes' : 'no' })}</div>
            {facts.replacesInstalled ? <div className="text-fail">{t('chat.skillPublishCard.replaceWarning')}</div> : null}
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-ink-2 p-2 text-meta">
              {JSON.stringify({ scripts: facts.validation?.scripts, tests: facts.validation?.tests }, null, 2)}
            </pre>
            <ApprovalActions
              onApprove={() => props.respondToApproval({ approved: true })}
              onReject={() => props.respondToApproval({ approved: false })}
              approveLabel={t('chat.skillPublishCard.approve')}
            />
          </div>
        ) : (
          <div className="text-aux">{t('chat.skillPublishCard.loading')}</div>
        )
      ) : (
        <TerminalBanner phase={phase} />
      )}
    </CardFrame>
  )
}
