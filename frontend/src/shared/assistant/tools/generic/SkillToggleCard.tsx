// M4c — SkillToggleCard (set_skill_enabled).
//
// Approve/reject card for the agent enabling/disabling one of its skills (mount/unmount its tools).
// Uses the same CardFrame + ApprovalActions pattern as other approval cards. Preview tier — reversible;
// the user approves the capability change. The mounted skill's own tools keep their independent
// approval, so enabling never silently grants a write.

import { CheckCircle2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillToggleCardProps } from '../a2ui'
import {
  ApprovalActions,
  ApprovalIcon,
  CardFrame,
  TerminalBanner,
  deriveCardPhase
} from '../_cardShell'

function propsOf(toolName: string, args: unknown, result: unknown): SkillToggleCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    skillName: '',
    enabled: true
  }) as unknown as SkillToggleCardProps
}

export function SkillToggleCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const verb = data.enabled ? '启用' : '停用'
  const effect = data.enabled ? '挂载其工具' : '卸载其工具'

  return (
    <CardFrame icon={<ApprovalIcon />} title={`${verb}技能`} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">{`${verb}技能「${data.skillName}」（${effect}）`}</div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{`已${verb}「${data.skillName}」`}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">操作失败，请重试。</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{`${verb}技能「${data.skillName}」`}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
