// M4b — SystemDocApprovalCard (update_system_md).
//
// Approve/reject card for the agent proposing an edit to one of its own Standing Context documents
// (soul / agent / rules / user). Mirrors MemoryApprovalCard's structure (CardFrame + ApprovalActions
// from _cardShell) so the edit gets a proper in-conversation approve/reject affordance instead of
// the generic ToolTraceCard. soul/rules (identity + hard constraints) get the high-risk red
// treatment + the safety-floor note; jailbreak / override phrasing in `rules` is rejected
// server-side (validate_rules_content) → the card then shows the error phase. The FULL new content
// rides the editable approval input; the card shows a bounded preview.

import { CheckCircle2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SystemDocApprovalCardProps } from '../a2ui'
import {
  ApprovalActions,
  ApprovalIcon,
  CardFrame,
  TerminalBanner,
  deriveCardPhase
} from '../_cardShell'

const DOC_LABELS: Record<string, string> = {
  soul: 'SOUL（身份）',
  agent: 'AGENT（操作笔记）',
  rules: 'RULES（硬约束）',
  user: 'USER（用户偏好）'
}

function propsOf(toolName: string, args: unknown, result: unknown): SystemDocApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    docName: '',
    highRisk: false,
    contentPreview: '',
    contentLength: 0
  }) as unknown as SystemDocApprovalCardProps
}

export function SystemDocApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const label = DOC_LABELS[data.docName] ?? data.docName
  const title = data.highRisk ? '⚠️ 改写身份 / 规则文档' : '改写 Standing Context 文档'

  return (
    <CardFrame icon={<ApprovalIcon />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">{`Agent 提议改写 ${label} 文档`}</div>
          {data.highRisk && (
            <div className="mt-1 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
              高危：这会改写你的身份 /
              硬约束。安全底线（PRODUCT_SAFETY_FLOOR）结构上不可被弱化，越权措辞会被服务端拒绝。请逐字确认下方内容后再批准。
            </div>
          )}
          {data.contentPreview && (
            <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-aux text-ink-fg-2">
              {data.contentPreview}
            </div>
          )}
          <div className="mt-0.5 text-meta text-ink-fg-2">{`${data.contentLength} 字符（批准后按此写入；如需改动让 agent 重新提议或到 Settings 编辑）`}</div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{`已更新 ${label} 文档`}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">
          更新被拒绝或失败（rules 内容可能触发安全校验，或文档过大）。
        </div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{`改写 ${label} 文档`}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
