// S2 W4 — SkillUninstallCard (skill_uninstall, edit tier + capability_change).
//
// Full-cleanup uninstall: DB row + on-disk directory + EVERY stored secret for the skill are
// removed (never the legacy row-only delete — stale-secret adoption). The card lists what will
// go, fetching the stored secret NAMES live from serve-api (values never leave the backend); a
// fetch failure only degrades the listing — the user can still decide (the destructive scope is
// stated either way).

import { useEffect, useState } from 'react'
import { PackageX } from 'lucide-react'
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
    <CardFrame icon={<PackageX size={13} strokeWidth={2} />} title="卸载 Skill" phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">将完全卸载以下 skill（不可逆）：</div>
          <div className="mt-1 font-mono text-meta text-ink-fg">{data.skillName || '(未指定)'}</div>
          <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1.5 text-aux text-ink-fg-3">
            删除范围：注册行 + 落盘目录 + 已存储的密钥
            {secretNames === null ? (
              secretsError ? (
                <span>（密钥清单不可用，卸载仍会一并删除）</span>
              ) : (
                <span>（正在取密钥清单…）</span>
              )
            ) : secretNames.length > 0 ? (
              <span className="font-mono text-meta">{`（${secretNames.join(' / ')}）`}</span>
            ) : (
              <span>（该 skill 未存储密钥）</span>
            )}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel="确认卸载"
          />
        </>
      ) : phase === 'done' ? (
        <div className="text-aux text-ink-fg-2">
          {data.removed
            ? `已卸载 ${data.skillName}${typeof data.removedSecrets === 'number' && data.removedSecrets > 0 ? `（含 ${data.removedSecrets} 个密钥）` : ''}。`
            : `${data.skillName} 本就不存在（无需卸载）。`}
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">卸载失败，请重试或到设置里手动移除。</div>
      ) : (
        <>
          <div className="font-mono text-meta text-ink-fg">{data.skillName}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
