// chat-panel P4 Phase 04a — DraftReplyCard (email_draft_reply, edit tier).
//
// The rich card for the reply-draft write tool. While the approval is pending it shows the
// Agent's proposed reply body in an EDITABLE textarea — plus To/CC/BCC override fields
// (empty = server-derived reply-all); the user may rewrite any of them before approving.
// On approve, if anything changed, the card first POSTs the edit to the gateway resolve
// side-channel (postApprovalEdit) so the second streamText call executes the edited
// fields — WITHOUT changing the ai@6 history input, so the signed approval stays valid
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
    bodyMarkdown: '',
    to: [],
    cc: [],
    bcc: []
  }) as unknown as DraftReplyCardProps
}

/** Parse a recipients text field (comma / semicolon / newline separated) into a clean list. */
function parseRecipients(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export function DraftReplyCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, result, toolCallId, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(args, result)
  // composer-parity dogfood-2 #3 — the proposed fields stream in (input-streaming → input-available),
  // so the card first mounts while args are still empty; a plain useState latched '' and never caught
  // up → the textarea stayed empty until execution. Track the user's own edit separately and, until
  // they type, keep the fields synced to the latest proposed values (adjust-on-prop-change, react.dev).
  // Once edited, their text wins (so approve sends what they see).
  const [body, setBody] = useState(data.bodyMarkdown)
  const [toText, setToText] = useState(data.to.join(', '))
  const [ccText, setCcText] = useState(data.cc.join(', '))
  const [bccText, setBccText] = useState(data.bcc.join(', '))
  const [edited, setEdited] = useState(false)
  const proposedKey = JSON.stringify([data.bodyMarkdown, data.to, data.cc, data.bcc])
  const [prevProposedKey, setPrevProposedKey] = useState(proposedKey)
  if (!edited && prevProposedKey !== proposedKey) {
    setPrevProposedKey(proposedKey)
    setBody(data.bodyMarkdown)
    setToText(data.to.join(', '))
    setCcText(data.cc.join(', '))
    setBccText(data.bcc.join(', '))
  }

  const curTo = parseRecipients(toText)
  const curCc = parseRecipients(ccText)
  const curBcc = parseRecipients(bccText)

  const onApprove = async (): Promise<void> => {
    // Edit-tier: when the user rewrote body/recipients, re-approve domain-side first so the
    // executed input is the edit (ai@6 history input unchanged → signature stays valid).
    const changed =
      body !== data.bodyMarkdown ||
      !sameList(curTo, data.to) ||
      !sameList(curCc, data.cc) ||
      !sameList(curBcc, data.bcc)
    if (changed) {
      await postApprovalEdit(toolCallId, {
        body_markdown: body,
        to: curTo,
        cc: curCc,
        bcc: curBcc
      })
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  const modeLabel = data.mode === 'reply' ? '仅答复发件人' : '答复全部'

  return (
    <CardFrame icon={<PenLine size={13} strokeWidth={2} />} title="回复草稿" phase={phase}>
      {phase === 'pending' ? (
        <div className="space-y-2">
          <div className="text-meta text-ink-fg-2">{`回复邮件 #${data.internalId} · ${modeLabel}（可编辑后再确认）`}</div>
          <RecipientField
            label="收件人"
            value={toText}
            onChange={(v) => {
              setEdited(true)
              setToText(v)
            }}
          />
          <RecipientField
            label="抄送"
            value={ccText}
            onChange={(v) => {
              setEdited(true)
              setCcText(v)
            }}
          />
          {(data.bcc.length > 0 || bccText.length > 0) && (
            <RecipientField
              label="密送"
              value={bccText}
              onChange={(v) => {
                setEdited(true)
                setBccText(v)
              }}
            />
          )}
          <textarea
            value={body}
            onChange={(e) => {
              setEdited(true)
              setBody(e.target.value)
            }}
            rows={6}
            className="scrollbar-thin w-full resize-y rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none focus:border-coral/50"
            aria-label="reply draft body"
          />
          <ApprovalActions onApprove={onApprove} onReject={onReject} approveLabel="创建草稿" />
        </div>
      ) : phase === 'done' ? (
        <div className="space-y-1.5">
          <div className="text-aux text-ink-fg">
            草稿已创建{data.userEdited ? '（含你的修改）' : ''}。
          </div>
          <RecipientSummary data={data} />
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
          <RecipientSummary data={data} />
          <DraftBodyPreview body={data.bodyMarkdown} />
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

/** One recipient text field. Empty = the server derives the list (reply-all semantics). */
function RecipientField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-meta font-medium text-ink-fg-2">{label}</div>
      <input
        type="text"
        value={value}
        placeholder="留空＝自动按答复全部派生"
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
        aria-label={label}
      />
    </div>
  )
}

/** Read-only recipient-override summary (done / authorized states); hidden when derived. */
function RecipientSummary({ data }: { data: DraftReplyCardProps }): React.JSX.Element | null {
  if (data.to.length === 0 && data.cc.length === 0 && data.bcc.length === 0) return null
  return (
    <div className="text-meta text-ink-fg-2">
      {data.to.length > 0 && <div>{`收件人：${data.to.join('，')}`}</div>}
      {data.cc.length > 0 && <div>{`抄送：${data.cc.join('，')}`}</div>}
      {data.bcc.length > 0 && <div>{`密送：${data.bcc.join('，')}`}</div>}
    </div>
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
