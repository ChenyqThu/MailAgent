// chat-panel P4 Phase 04b — SendApprovalCard (email_prepare_send, blocking tier).
//
// The final human gate before a REAL outbound send. While the approval is pending it shows the
// full draft — To / CC / BCC / Subject / Body — ALL editable, plus safety warnings (external /
// personal recipients, sensitive terms) and an approval-expiry countdown. "允许发送" sends as
// shown; editing any field then "允许发送" = "修改后继续" (the edit rides the 04a resolve
// side-channel so the gateway re-computes the content hash over the edited payload while the
// ai@6 history input — hence the signed approval — stays valid). "取消" rejects. Once sent it
// shows the message id. Renders from the SHARED a2ui mapper so card + audit can't diverge.

import { useEffect, useMemo, useState } from 'react'
import { Send, ShieldAlert } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SendApprovalCardProps } from '../a2ui'
import { detectExternalRecipients, detectSensitiveTerms } from '../security/hashOutboundPayload'
import {
  ApprovalActions,
  CardFrame,
  TerminalBanner,
  deriveCardPhase,
  postApprovalEdit
} from '../_cardShell'

/** Mirrors the domain ApprovalGuard DEFAULT_APPROVAL_TTL_MS (5 min). The domain expiry is the
 *  authoritative gate; this client-side countdown (from when the card mounted ≈ when the
 *  approval was registered) is an approximate urgency signal only. */
const SEND_APPROVAL_TTL_MS = 5 * 60 * 1000

function propsOf(args: unknown, result: unknown): SendApprovalCardProps {
  const payload = buildToolA2UIPayload('email_prepare_send', { args, result })
  return (payload?.props ?? {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    bodyMarkdown: ''
  }) as unknown as SendApprovalCardProps
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

export function SendApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, result, toolCallId, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(args, result)

  const [toText, setToText] = useState(data.to.join(', '))
  const [ccText, setCcText] = useState(data.cc.join(', '))
  const [bccText, setBccText] = useState(data.bcc.join(', '))
  const [subject, setSubject] = useState(data.subject)
  const [body, setBody] = useState(data.bodyMarkdown)

  // Approximate expiry countdown (domain guard is the real enforcement).
  const [remainingMs, setRemainingMs] = useState(SEND_APPROVAL_TTL_MS)
  useEffect(() => {
    if (phase !== 'pending') return
    const mountedAt = Date.now()
    const tick = (): void =>
      setRemainingMs(Math.max(0, SEND_APPROVAL_TTL_MS - (Date.now() - mountedAt)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [phase])

  const curTo = parseRecipients(toText)
  const curCc = parseRecipients(ccText)
  const curBcc = parseRecipients(bccText)

  const externals = useMemo(
    () => detectExternalRecipients({ to: curTo, cc: curCc, bcc: curBcc }),
    [toText, ccText, bccText] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const sensitive = useMemo(() => detectSensitiveTerms({ subject, body }), [subject, body])

  const expired = remainingMs <= 0
  const noRecipients = curTo.length === 0

  const onApprove = async (): Promise<void> => {
    const changed =
      !sameList(curTo, data.to) ||
      !sameList(curCc, data.cc) ||
      !sameList(curBcc, data.bcc) ||
      subject !== data.subject ||
      body !== data.bodyMarkdown
    // Edit → re-approve domain-side: post the edited fields so the executed send is the edit
    // (ai@6 history input unchanged → signature valid). Only the editable fields are sent.
    if (changed) {
      await postApprovalEdit(toolCallId, {
        to: curTo,
        cc: curCc,
        bcc: curBcc,
        subject,
        body_markdown: body
      })
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={<Send size={13} strokeWidth={2} />} title="发送邮件" phase={phase}>
      {phase === 'pending' ? (
        <div className="space-y-2">
          <SendField
            label="收件人"
            value={toText}
            onChange={setToText}
            placeholder="多个收件人用逗号分隔"
          />
          <SendField label="抄送" value={ccText} onChange={setCcText} placeholder="可留空" />
          <SendField label="密送" value={bccText} onChange={setBccText} placeholder="可留空" />
          <SendField label="主题" value={subject} onChange={setSubject} />
          <div>
            <FieldLabel>正文</FieldLabel>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="scrollbar-thin w-full resize-y rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none focus:border-coral/50"
              aria-label="send body"
            />
          </div>

          <SendWarnings externals={externals} sensitive={sensitive} />

          <div className="flex items-center justify-between pt-0.5">
            <CountdownPill remainingMs={remainingMs} expired={expired} />
            {noRecipients && <span className="text-meta text-fail">请至少填写一个收件人</span>}
          </div>

          <ApprovalActions
            onApprove={onApprove}
            onReject={onReject}
            approveLabel="允许发送"
            disabled={expired || noRecipients}
          />
        </div>
      ) : phase === 'done' ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-aux text-ink-fg">
            <Send size={13} strokeWidth={2} className="shrink-0 text-ok" />
            <span>邮件已发送{data.archivedToSent ? '（已归入已发送）' : ''}。</span>
          </div>
          <div className="text-meta text-ink-fg-2">
            收件人：{data.to.join('，') || '—'}
            {data.messageId ? ` · ${data.messageId}` : ''}
          </div>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">发送失败，邮件未发出。请重试或让助手重新发起。</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{`发送给 ${data.to.join('，') || '—'}：${data.subject || '（无主题）'}`}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-0.5 text-meta font-medium text-ink-fg-2">{children}</div>
}

function SendField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
        aria-label={label}
      />
    </div>
  )
}

/** External-recipient + sensitive-term warnings — the high-risk send safety surface. */
function SendWarnings({
  externals,
  sensitive
}: {
  externals: string[]
  sensitive: string[]
}): React.JSX.Element | null {
  if (externals.length === 0 && sensitive.length === 0) return null
  return (
    <div className="space-y-1 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5">
      {externals.length > 0 && (
        <div className="flex items-start gap-1.5 text-meta text-warn">
          <ShieldAlert size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>外部 / 个人邮箱收件人：{externals.join('，')} —— 请确认。</span>
        </div>
      )}
      {sensitive.length > 0 && (
        <div className="flex items-start gap-1.5 text-meta text-warn">
          <ShieldAlert size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>正文含敏感词：{sensitive.join('、')} —— 发送前请再核对。</span>
        </div>
      )}
    </div>
  )
}

function CountdownPill({
  remainingMs,
  expired
}: {
  remainingMs: number
  expired: boolean
}): React.JSX.Element {
  if (expired) return <span className="text-meta text-fail">审批已过期，请让助手重新发起</span>
  const total = Math.ceil(remainingMs / 1000)
  const mm = Math.floor(total / 60)
  const ss = String(total % 60).padStart(2, '0')
  return <span className="text-meta text-ink-fg-3">{`审批有效期 ${mm}:${ss}`}</span>
}
