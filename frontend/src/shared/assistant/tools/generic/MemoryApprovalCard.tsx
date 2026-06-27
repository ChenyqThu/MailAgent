// M0 — MemoryApprovalCard (memory_write / memory_delete).
//
// The approve/reject card for the agent-memory write tools. cutover (v0.20.0) moved the default
// engine to the AI SDK Gateway and re-added the 4 memory tools there, but without a renderer
// card these write tools fell through to the generic ToolTraceCard (trace only, NO approve /
// reject buttons) — so "记住某事" hung with no way to confirm. This card mirrors
// ApprovalActionCard's structure (shared CardFrame + ApprovalActions) so memory writes get the
// same approve/reject affordance. Memory has no email context — this card NEVER shows an
// "邮件 #id".

import { CheckCircle2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type MemoryApprovalCardProps } from '../a2ui'
import {
  ApprovalActions,
  ApprovalIcon,
  CardFrame,
  TerminalBanner,
  deriveCardPhase
} from '../_cardShell'

function propsOf(toolName: string, args: unknown, result: unknown): MemoryApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    operation: 'write',
    scope: 'user',
    memoryKey: ''
  }) as unknown as MemoryApprovalCardProps
}

export function MemoryApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const isDelete = data.operation === 'delete'
  const title = isDelete ? '忘记偏好' : '记住偏好'

  return (
    <CardFrame icon={<ApprovalIcon />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          {isDelete ? (
            <div className="text-aux text-ink-fg">{`忘记「${data.memoryKey}」`}</div>
          ) : (
            <>
              <div className="text-aux text-ink-fg">{`记住「${data.memoryKey}」`}</div>
              {data.valuePreview && (
                // valuePreview is often a free-form CN preference string; keep it at text-aux
                // (not text-meta mono) per the no-cjk-in-mono-size design rule's intent.
                <div className="mt-0.5 break-words text-aux text-ink-fg-2">{data.valuePreview}</div>
              )}
              {data.scope !== 'user' && (
                <div className="mt-0.5 text-aux text-ink-fg-2">{`范围：${data.scope}`}</div>
              )}
              {data.priority !== undefined && (
                <div className="mt-0.5 text-aux text-ink-fg-2">{`优先级 ${data.priority}`}</div>
              )}
            </>
          )}
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{isDelete ? `已忘记「${data.memoryKey}」` : `已记住「${data.memoryKey}」`}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">操作失败，请重试或让助手重新发起。</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">
            {isDelete ? `忘记「${data.memoryKey}」` : `记住「${data.memoryKey}」`}
          </div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
