// M4c — SkillToggleCard (set_skill_enabled).
//
// Approve/reject card for the agent enabling/disabling one of its skills (mount/unmount its tools).
// Uses the same CardFrame + ApprovalActions pattern as other approval cards. Preview tier — reversible;
// the user approves the capability change. The mounted skill's own tools keep their independent
// approval, so enabling never silently grants a write.

import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillToggleCardProps } from '../a2ui'
import { ApprovalActions, ApprovalIcon, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

function propsOf(toolName: string, args: unknown, result: unknown): SkillToggleCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    skillName: '',
    enabled: true
  }) as unknown as SkillToggleCardProps
}

export function SkillToggleCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  // enabled/disabled compose differently across languages ("启用技能" vs "Enable skill"), so each
  // state gets a full phrase rather than concatenating a verb — {name} carries the skill name.
  const en = data.enabled
  const name = data.skillName

  return (
    <CardFrame
      icon={<ApprovalIcon />}
      title={t(en ? 'chat.skillToggleCard.titleEnable' : 'chat.skillToggleCard.titleDisable')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">
            {t(en ? 'chat.skillToggleCard.pendingEnable' : 'chat.skillToggleCard.pendingDisable', {
              name
            })}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={(reason) => respondToApproval({ approved: false, reason })}
            rejectReason
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>
            {t(en ? 'chat.skillToggleCard.doneEnable' : 'chat.skillToggleCard.doneDisable', {
              name
            })}
          </span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.skillToggleCard.error')}</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">
            {t(en ? 'chat.skillToggleCard.summaryEnable' : 'chat.skillToggleCard.summaryDisable', {
              name
            })}
          </div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
