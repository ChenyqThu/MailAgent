// S2 W1 (task 07-02-s2-exec-skill-install) — ExecApprovalCard (run_command / file_read / file_write).
//
// The edit-tier approval card for the local exec tools. It shows the EXACT command / file the model
// proposes (so the user reviews precisely what will run — there is NO sandbox once approved) plus a
// "总是允许" affordance: ticking it and approving asks the gateway to derive a full-PIN structured
// whitelist rule from THIS approved action (POST /api/ai/policy/remember → the owner policy API), so a
// matching future run skips the card. Rule creation is an OWNER action only — no tool can reach it.
//
// 🔴 "总是允许" is best-effort: if the rule creation fails, the approval STILL proceeds (the user
//    already decided to run this once) — the whitelist just isn't created, so next time it asks again.
//    A failed run gets no rule (only a successful approve path fires it); reject never creates a rule.

import { useState } from 'react'
import { Terminal, FileText, FilePenLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type ExecApprovalCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'
import { resolveAiGatewayBaseUrl } from '../../runtime/flags'

/** POST the "always allow" to the gateway (POST /api/ai/policy/remember). The gateway peeks the
 *  pending exec approval (the SAME approved argv/cwd/path, so the model can't forge a broader rule),
 *  derives a full-PIN structured whitelist rule, and persists it (owner action — no tool can reach
 *  this). Throws the typed error code on failure; the caller treats a failure as best-effort. Local
 *  (not exported) — one consumer, keeps this component file free of shared non-component exports. */
async function postRememberExecPolicy(toolCallId: string): Promise<void> {
  const base = resolveAiGatewayBaseUrl()
  // '' (same-origin web proxy) is a VALID base but falsy — null-check explicitly, never `!base`.
  if (base == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${base}/api/ai/policy/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(code)
  }
}

// The i18n key suffix per exec kind — title / prompt-label / always-allow hint all keyed by it
// under chat.execApprovalCard.<group>.<kind> (kind == toolName for these tools).
const KIND_KEYS: Record<string, string> = {
  run_command: 'runCommand',
  file_read: 'fileRead',
  file_write: 'fileWrite'
}

function iconFor(kind: string): React.ReactNode {
  if (kind === 'file_read') return <FileText size={13} strokeWidth={2} />
  if (kind === 'file_write') return <FilePenLine size={13} strokeWidth={2} />
  return <Terminal size={13} strokeWidth={2} />
}

function propsOf(toolName: string, args: unknown, result: unknown): ExecApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  // summary is not rendered by this card (it shows the exact argv/path), so the fallback is empty.
  return (payload?.props ?? {
    kind: 'run_command',
    summary: ''
  }) as unknown as ExecApprovalCardProps
}

export function ExecApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, toolCallId, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const kindKey = KIND_KEYS[data.kind]
  const title = KIND_KEYS[toolName]
    ? t(`chat.execApprovalCard.title.${KIND_KEYS[toolName]}`)
    : t('chat.execApprovalCard.title.fallback')
  /** The mono line (command / path — never CJK) shown under the label. */
  const monoLine = (): string => {
    if (data.kind === 'run_command')
      return data.argv?.join(' ') || t('chat.execApprovalCard.emptyArgv')
    return data.path ?? '?'
  }
  const [alwaysAllow, setAlwaysAllow] = useState(false)

  const onApprove = async (): Promise<void> => {
    if (alwaysAllow) {
      // Best-effort: a whitelist-creation failure must NOT block the run the user approved.
      try {
        await postRememberExecPolicy(toolCallId)
      } catch {
        /* rule not created (e.g. gateway hiccup) → next time it asks again; proceed with the run */
      }
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={iconFor(data.kind)} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {kindKey
              ? t(`chat.execApprovalCard.prompt.${kindKey}`)
              : t('chat.execApprovalCard.prompt.fallback')}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{monoLine()}</div>
          {data.kind === 'run_command' && data.cwd ? (
            <div className="mt-0.5 break-all font-mono text-meta text-ink-fg-3">{data.cwd}</div>
          ) : null}
          {data.kind === 'file_write' && data.mode ? (
            <div className="mt-0.5 text-aux text-ink-fg-3">
              {t('chat.execApprovalCard.writeMode', { mode: data.mode })}
            </div>
          ) : null}
          <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={alwaysAllow}
                onChange={(e) => setAlwaysAllow(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-[rgb(var(--c-accent))]"
              />
              <span className="text-aux text-ink-fg-2">
                {kindKey
                  ? t(`chat.execApprovalCard.allowHint.${kindKey}`)
                  : t('chat.execApprovalCard.allowHint.fallback')}
                <span className="mt-0.5 block text-ink-fg-3">
                  {t('chat.execApprovalCard.allowWarn')}
                </span>
              </span>
            </label>
          </div>
          <ApprovalActions
            onApprove={onApprove}
            onReject={onReject}
            approveLabel={t('chat.execApprovalCard.approve')}
          />
        </>
      ) : phase === 'done' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{monoLine()}</div>
          {typeof data.exitCode === 'number' || typeof data.bytesWritten === 'number' ? (
            <div className="mt-0.5 text-aux text-ink-fg-2">
              {typeof data.exitCode === 'number'
                ? t('chat.execApprovalCard.exitCode', { code: data.exitCode })
                : ''}
              {typeof data.bytesWritten === 'number'
                ? t('chat.execApprovalCard.bytesWritten', { bytes: data.bytesWritten })
                : ''}
            </div>
          ) : null}
          {/* Security disclosure — which stored secrets this command could read. The backend has
              reported these since 877dc17c ("W4 审批卡展示") but nothing rendered them, so an
              approved command read the owner's per-skill secrets with no surface saying which.
              They only exist post-run (the overlay is resolved inside /exec/run), so this is a
              disclosure, not a pre-approval warning — styled to be noticed regardless. */}
          {(data.injectedSecretNames?.length ?? 0) > 0 ? (
            <div className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2">
              <div className="text-aux text-warn">
                {t('chat.execApprovalCard.secretsInjected', {
                  count: data.injectedSecretNames?.length ?? 0
                })}
              </div>
              <div className="mt-0.5 break-all font-mono text-meta text-ink-fg-2">
                {data.injectedSecretNames?.join(', ')}
              </div>
            </div>
          ) : null}
          {(data.firstRunRecorded?.length ?? 0) > 0 ? (
            <div className="mt-1 text-aux text-ink-fg-3">
              {t('chat.execApprovalCard.firstRunRecorded', {
                names: data.firstRunRecorded?.join(', ')
              })}
            </div>
          ) : null}
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.execApprovalCard.error')}</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{monoLine()}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
