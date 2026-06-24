// chat-panel P4 Phase 04a — DraftReplyCard (email_draft_reply, edit tier).
//
// The rich card for the reply-draft write tool. While the approval is pending it shows the
// Agent's proposed reply body in an EDITABLE textarea; the user may rewrite it before
// approving. On approve, if the body changed, the card first POSTs the edit to the gateway
// resolve side-channel (postApprovalEdit) so the second streamText call executes the edited
// body — WITHOUT changing the ai@6 history input, so the signed approval stays valid
// (architecture §13.10.2(1) "edit → re-approve"). Then it sends the native approval. Once the
// draft is created it shows the draft id + mailbox. Renders from the SHARED a2ui mapper
// (buildToolA2UIPayload) so the card and the audit payload can never diverge.

import { useState } from 'react'
import { PenLine } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type DraftReplyCardProps } from '../a2ui'
import {
  ApprovalActions,
  CardFrame,
  TerminalBanner,
  deriveCardPhase,
  postApprovalEdit
} from '../_cardShell'

function propsOf(args: unknown, result: unknown): DraftReplyCardProps {
  const payload = buildToolA2UIPayload('email_draft_reply', { args, result })
  return (payload?.props ?? {
    internalId: -1,
    bodyMarkdown: ''
  }) as unknown as DraftReplyCardProps
}

export function DraftReplyCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, result, toolCallId, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(args, result)
  const [body, setBody] = useState(data.bodyMarkdown)

  const onApprove = async (): Promise<void> => {
    // Edit-tier: when the user rewrote the body, re-approve domain-side first so the executed
    // input is the edited body (ai@6 history input unchanged → signature stays valid).
    if (body !== data.bodyMarkdown) {
      await postApprovalEdit(toolCallId, { body_markdown: body })
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={<PenLine size={13} strokeWidth={2} />} title="回复草稿" phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="mb-1 text-meta text-ink-fg-2">{`回复邮件 #${data.internalId}（可编辑后再确认）`}</div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="scrollbar-thin w-full resize-y rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none focus:border-coral/50"
            aria-label="reply draft body"
          />
          <ApprovalActions onApprove={onApprove} onReject={onReject} approveLabel="创建草稿" />
        </>
      ) : phase === 'done' ? (
        <div className="space-y-1.5">
          <div className="text-aux text-ink-fg">
            草稿已创建{data.userEdited ? '（含你的修改）' : ''}。
          </div>
          <div className="text-meta text-ink-fg-2">
            {data.mailbox ? `文件夹：${data.mailbox}` : '已存入草稿箱'}
            {data.draftId ? ` · ${data.draftId}` : ''}
          </div>
          <DraftBodyPreview body={data.bodyMarkdown} />
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">创建草稿失败，请重试或让助手重新发起。</div>
      ) : (
        <>
          <DraftBodyPreview body={data.bodyMarkdown} />
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

/** Read-only body preview (done / authorized / terminal states). */
function DraftBodyPreview({ body }: { body: string }): React.JSX.Element {
  return (
    <pre className="scrollbar-thin mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-meta leading-relaxed text-ink-fg-1">
      {body || '（空）'}
    </pre>
  )
}
