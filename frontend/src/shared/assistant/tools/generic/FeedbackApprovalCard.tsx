// FeedbackApprovalCard（task 08-27-l4-tab-workspace P4a）—— submit_feedback 的审批卡。
//
// 三个按钮：**改一改 / 不发 / 发送**。
//   · 「改一改」展开输入框，改完再点发送 → 先 POST 04a 的 resolve 侧信道（SendApprovalCard
//     先例），执行的是**改后的** payload。agent 整理的措辞未必对，只给「发 / 不发」不够用。
//   · 「不发」= respondToApproval({approved:false})，带可选理由。
//   · 「发送」= respondToApproval({approved:true})。
//
// 🔴 卡弹出时**什么都还没发出去**。审批链的语义是 needsApproval 先跑、execute 只在批准后
//    的第二轮跑（types.ts auditedWriteTool），本卡只负责「让人看清楚要发什么」。
// 🔴 没有「以后都自动」affordance，也不该有：对外发送是安全地板那一档（class outbound +
//    tool_prefs configurable=False，四层都写死恒 ask）。
// 🔴 截图恒为「无」——agent 截不了图，schema 里根本没有这个字段。

import { useState } from 'react'
import { MessageSquareWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { FEEDBACK_FREQUENCIES, FEEDBACK_KINDS } from '@shared/feedback/contract'
import { ApprovalActions, CardFrame, CardParams, TerminalBanner } from '../_cardShell'
import { deriveCardPhase, postApprovalEdit } from '../_cardShell.lib'

interface FeedbackArgs {
  kind: string
  title: string
  detail: string
  freq: string
  email: string
  attachDiagnostics: boolean
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(obj: Record<string, unknown> | null, key: string): string {
  const v = obj?.[key]
  return typeof v === 'string' ? v : ''
}

function parseArgs(args: unknown, argsText: string | undefined): FeedbackArgs {
  let obj = asRecord(args)
  if (!obj && argsText) {
    try {
      obj = asRecord(JSON.parse(argsText))
    } catch {
      obj = null
    }
  }
  return {
    kind: str(obj, 'kind'),
    title: str(obj, 'title'),
    detail: str(obj, 'detail'),
    freq: str(obj, 'freq'),
    email: str(obj, 'email'),
    attachDiagnostics: obj?.attach_diagnostics === true
  }
}

export function FeedbackApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, argsText, toolCallId, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const proposed = parseArgs(args, argsText)

  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState(proposed.kind)
  const [title, setTitle] = useState(proposed.title)
  const [detail, setDetail] = useState(proposed.detail)
  const [freq, setFreq] = useState(proposed.freq)

  // 参数流式阶段卡就已挂载，此时 args 还是空的 —— 用户没动过就跟着最新的提案值走
  // （adjust-on-prop-change，SendApprovalCard / DraftReplyCard 同款闩）。
  const [touched, setTouched] = useState(false)
  const proposedKey = JSON.stringify([
    proposed.kind,
    proposed.title,
    proposed.detail,
    proposed.freq
  ])
  const [prevKey, setPrevKey] = useState(proposedKey)
  if (!touched && prevKey !== proposedKey) {
    setPrevKey(proposedKey)
    setKind(proposed.kind)
    setTitle(proposed.title)
    setDetail(proposed.detail)
    setFreq(proposed.freq)
  }
  const edit =
    (setter: (v: string) => void) =>
    (v: string): void => {
      setTouched(true)
      setter(v)
    }

  const isProblem = kind === '问题'
  const changed =
    kind !== proposed.kind ||
    title !== proposed.title ||
    detail !== proposed.detail ||
    // 类型不是「问题」时复现频率不参与比对：它压根不会进 payload。
    (isProblem && freq !== proposed.freq)

  const onApprove = async (): Promise<void> => {
    if (changed) {
      await postApprovalEdit(toolCallId, {
        kind,
        title,
        detail,
        // 🔴 换成建议 / 咨询时把 freq 显式清空 —— 不清的话侧信道会把旧值原样写回去，
        //    payload 里就出现了一个「建议」类的复现频率。
        freq: isProblem ? freq : undefined
      })
    }
    respondToApproval({ approved: true })
  }
  const onReject = (reason?: string): void => respondToApproval({ approved: false, reason })

  const params = [
    { id: 'kind', label: t('chat.feedbackApprovalCard.kind'), value: kind || '—' },
    { id: 'title', label: t('chat.feedbackApprovalCard.title'), value: title || '—', accent: true },
    ...(detail
      ? [{ id: 'detail', label: t('chat.feedbackApprovalCard.detail'), value: detail }]
      : []),
    ...(isProblem && freq
      ? [{ id: 'freq', label: t('chat.feedbackApprovalCard.freq'), value: freq }]
      : []),
    ...(proposed.email
      ? [{ id: 'email', label: t('chat.feedbackApprovalCard.email'), value: proposed.email }]
      : []),
    {
      id: 'attachments',
      label: t('chat.feedbackApprovalCard.attachments'),
      value: proposed.attachDiagnostics
        ? t('chat.feedbackApprovalCard.attachDiagnostics')
        : t('chat.feedbackApprovalCard.attachNone')
    }
  ]

  return (
    <CardFrame
      icon={<MessageSquareWarning size={13} strokeWidth={2} />}
      title={t('chat.feedbackApprovalCard.cardTitle')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <div className="space-y-2">
          {editing ? (
            <div className="space-y-2">
              <div>
                <FieldLabel>{t('chat.feedbackApprovalCard.kind')}</FieldLabel>
                <div className="flex gap-1.5">
                  {FEEDBACK_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => edit(setKind)(k)}
                      aria-pressed={kind === k}
                      className={
                        kind === k
                          ? 'rounded-md border border-coral/40 bg-coral/15 px-2 py-1 text-meta text-coral'
                          : 'rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-meta text-ink-fg-2 hover:bg-ink-3'
                      }
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <FieldLabel>{t('chat.feedbackApprovalCard.title')}</FieldLabel>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => edit(setTitle)(e.target.value)}
                  aria-label={t('chat.feedbackApprovalCard.title')}
                  className="w-full rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none focus:border-coral/50"
                />
              </div>
              <div>
                <FieldLabel>{t('chat.feedbackApprovalCard.detail')}</FieldLabel>
                <textarea
                  value={detail}
                  rows={5}
                  onChange={(e) => edit(setDetail)(e.target.value)}
                  aria-label={t('chat.feedbackApprovalCard.detail')}
                  className="scrollbar-thin w-full resize-y rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none focus:border-coral/50"
                />
              </div>
              {/* 🔴 复现频率只在「问题」类出现（与设置里那个弹窗同一条判据）。 */}
              {isProblem ? (
                <div>
                  <FieldLabel>{t('chat.feedbackApprovalCard.freq')}</FieldLabel>
                  <div className="flex gap-1.5">
                    {FEEDBACK_FREQUENCIES.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => edit(setFreq)(f)}
                        aria-pressed={freq === f}
                        className={
                          freq === f
                            ? 'rounded-md border border-coral/40 bg-coral/15 px-2 py-1 text-meta text-coral'
                            : 'rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-meta text-ink-fg-2 hover:bg-ink-3'
                        }
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <CardParams items={params} />
          )}

          <div className="text-meta text-ink-fg-3">
            {t('chat.feedbackApprovalCard.viaAgentNote')}
          </div>

          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="rounded-md text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
          >
            {editing
              ? t('chat.feedbackApprovalCard.editDone')
              : t('chat.feedbackApprovalCard.edit')}
          </button>

          <ApprovalActions
            onApprove={onApprove}
            onReject={onReject}
            approveLabel={t('chat.feedbackApprovalCard.approve')}
            disabled={title.trim().length === 0}
            rejectReason
          />
        </div>
      ) : phase === 'done' ? (
        <div className="text-aux text-ink-fg">{t('chat.feedbackApprovalCard.sent')}</div>
      ) : phase === 'error' ? (
        // 🔴 失败可见：私有 API 的失效是静默的，这里必须明说「没发出去」。
        <div className="text-aux text-fail">{t('chat.feedbackApprovalCard.failed')}</div>
      ) : (
        <>
          <CardParams items={params} />
          {/* 诊断包在批准之后才组装，3.2G 库上要几十秒；不说一句的话「执行中」的卡看起来
              就是不动了。只在真会等的那条路（带诊断包）上出现。 */}
          {phase === 'authorized' && proposed.attachDiagnostics ? (
            <div data-diagnostics-hint className="text-meta text-ink-fg-3">
              {t('chat.feedbackApprovalCard.buildingDiagnostics')}
            </div>
          ) : null}
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-0.5 text-meta font-medium text-ink-fg-2">{children}</div>
}
