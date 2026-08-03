// chat-panel P4 Phase 04a — ApprovalActionCard (email_flag / email_archive / email_pin).
//
// The generic approve/reject card for the simple preview-tier write tools that don't warrant a
// bespoke card. It shows a one-line summary of the proposed change (built by the shared a2ui
// mapper) and the approve/reject row; once it runs it shows a short confirmation. No editable
// fields (preview tier = approve/reject only).

import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type ApprovalActionCardProps } from '../a2ui'
import { ApprovalActions, ApprovalIcon, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

// tool name → title key suffix; the model-facing summary is a2ui data (out of i18n scope) so the
// fallback below is an empty string localized at render time (data.summary || summaryFallback).
const TITLE_KEYS: Record<string, string> = {
  email_flag: 'emailFlag',
  email_archive: 'emailArchive',
  email_pin: 'emailPin'
}

function propsOf(toolName: string, args: unknown, result: unknown): ApprovalActionCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    toolName,
    internalId: -1,
    summary: ''
  }) as unknown as ApprovalActionCardProps
}

export function ApprovalActionCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const title = TITLE_KEYS[toolName]
    ? t(`chat.approvalActionCard.title.${TITLE_KEYS[toolName]}`)
    : t('chat.approvalActionCard.title.fallback')
  const summary = data.summary || t('chat.approvalActionCard.summaryFallback')

  return (
    <CardFrame icon={<ApprovalIcon />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">{summary}</div>
          <div className="mt-0.5 text-meta text-ink-fg-2">
            {t('chat.approvalActionCard.emailRef', { id: data.internalId })}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{t('chat.approvalActionCard.doneWithRef', { summary, id: data.internalId })}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.approvalActionCard.error')}</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{summary}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
