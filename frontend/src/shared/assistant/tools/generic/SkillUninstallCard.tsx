// S2 W4 — SkillUninstallCard (skill_uninstall, edit tier + capability_change).
//
// Full-cleanup uninstall: DB row + on-disk directory + EVERY stored secret for the skill are
// removed (never the legacy row-only delete — stale-secret adoption). The card lists what will
// go, fetching the stored secret NAMES live from serve-api (values never leave the backend); a
// fetch failure only degrades the listing — the user can still decide (the destructive scope is
// stated either way).

import { useEffect, useState } from 'react'
import { PackageX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillUninstallCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'

// Mirrors SkillInstallConfirmCard.resolveApiBaseUrl (intentionally duplicated, same rationale).
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

async function fetchSecretNames(name: string): Promise<string[]> {
  const resp = await fetch(
    `${resolveApiBaseUrl()}/agent/skills/${encodeURIComponent(name)}/secrets`,
    { credentials: 'include' }
  )
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as {
    status?: string
    data?: { secrets?: Array<{ name?: string }> }
  }
  if (body.status !== 'success') throw new Error('E_BAD_ENVELOPE')
  return (body.data?.secrets ?? []).map((s) => s.name).filter((n): n is string => !!n)
}

function propsOf(toolName: string, args: unknown, result: unknown): SkillUninstallCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? { skillName: '' }) as unknown as SkillUninstallCardProps
}

export function SkillUninstallCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const [secretNames, setSecretNames] = useState<string[] | null>(null)
  const [secretsError, setSecretsError] = useState(false)

  useEffect(() => {
    if (phase !== 'pending' || !data.skillName) return
    let cancelled = false
    fetchSecretNames(data.skillName)
      .then((names) => {
        if (!cancelled) setSecretNames(names)
      })
      .catch(() => {
        if (!cancelled) setSecretsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [phase, data.skillName])

  return (
    <CardFrame
      icon={<PackageX size={13} strokeWidth={2} />}
      title={t('chat.skillUninstallCard.title')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">{t('chat.skillUninstallCard.lead')}</div>
          <div className="mt-1 font-mono text-meta text-ink-fg">
            {data.skillName || t('chat.skillUninstallCard.unspecified')}
          </div>
          <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1.5 text-aux text-ink-fg-3">
            {t('chat.skillUninstallCard.scope')}
            {secretNames === null ? (
              secretsError ? (
                <span>{t('chat.skillUninstallCard.secretsUnavailable')}</span>
              ) : (
                <span>{t('chat.skillUninstallCard.secretsLoading')}</span>
              )
            ) : secretNames.length > 0 ? (
              <span className="font-mono text-meta">
                {t('chat.skillUninstallCard.secretsList', { names: secretNames.join(' / ') })}
              </span>
            ) : (
              <span>{t('chat.skillUninstallCard.secretsNone')}</span>
            )}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel={t('chat.skillUninstallCard.approve')}
          />
        </>
      ) : phase === 'done' ? (
        <div className="text-aux text-ink-fg-2">
          {data.removed
            ? typeof data.removedSecrets === 'number' && data.removedSecrets > 0
              ? t('chat.skillUninstallCard.removedWithSecrets', {
                  name: data.skillName,
                  count: data.removedSecrets
                })
              : t('chat.skillUninstallCard.removed', { name: data.skillName })
            : t('chat.skillUninstallCard.notExist', { name: data.skillName })}
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.skillUninstallCard.error')}</div>
      ) : (
        <>
          <div className="font-mono text-meta text-ink-fg">{data.skillName}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
