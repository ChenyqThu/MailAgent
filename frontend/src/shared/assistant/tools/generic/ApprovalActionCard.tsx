// chat-panel P4 Phase 04a — ApprovalActionCard (email_flag / email_archive / email_pin).
//
// The generic approve/reject card for the simple preview-tier write tools that don't warrant a
// bespoke card. It shows a one-line summary of the proposed change (built by the shared a2ui
// mapper) and the approve/reject row; once it runs it shows a short confirmation. No editable
// fields (preview tier = approve/reject only).

import { CheckCircle2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type ApprovalActionCardProps } from '../a2ui'
import {
  ApprovalActions,
  ApprovalIcon,
  CardFrame,
  TerminalBanner,
  deriveCardPhase
} from '../_cardShell'

const TITLES: Record<string, string> = {
  email_flag: '更新邮件标记',
  email_archive: '归档邮件',
  email_pin: '置顶/取消置顶'
}

function propsOf(toolName: string, args: unknown, result: unknown): ApprovalActionCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    toolName,
    internalId: -1,
    summary: '执行写操作'
  }) as unknown as ApprovalActionCardProps
}

export function ApprovalActionCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const title = TITLES[toolName] ?? '写操作确认'

  return (
    <CardFrame icon={<ApprovalIcon />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">{data.summary}</div>
          <div className="mt-0.5 text-meta text-ink-fg-2">{`邮件 #${data.internalId}`}</div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{`${data.summary}（邮件 #${data.internalId}）`}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">操作失败，请重试或让助手重新发起。</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{data.summary}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
