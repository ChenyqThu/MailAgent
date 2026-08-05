// chat-panel P4 Phase 04a — shared chrome + approval state for the rich A2UI tool cards.
//
// Every rich card (DraftReplyCard / NotionSyncCard / ApprovalActionCard) shares the same
// visual frame (icon + title + status pill + body) and the same HITL wiring (approve / reject
// via assistant-ui's native respondToApproval; edit-tier additionally POSTs the edit to the
// gateway resolve side-channel first). This module owns those shared pieces so each card is
// just "frame + its own body". MailAgent tokens only → reskins across theme × accent for free.
//
// 08-05 beUI tool-approval 收编（呈现层 A2–A5，判定链一个字节不动）：
//   A2 `CardParams` —— 参数区统一成 label/value 两列 `<dl>` grid（原来各卡自排 flex 行）。
//   A3 状态胶囊补 `approving`（决策在途）——见 PHASE_PILL 注释里的 7 态对照。
//   A4 `CardDetails` —— pending→非 pending 时自动收起评审详情（决策后不再占版面）。
//   A5 `ApprovalActions` 操作条 `AnimatePresence` 退场 + 按钮 `whileTap`。
// 🔴 A1「Always allow」按钮**有意不做** —— 它会改写 policy_rules（把工具挪出恒 HITL），属审批
//    判定面，归 P1 的审批三档包；本轮只碰呈现层。

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { Check, ChevronDown, Loader2, ShieldQuestion, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { SPRING_PRESS, SPRING_SWAP } from '@shared/lib/motion-tokens'
// 纯逻辑面拆去 _cardShell.lib.ts（08-02 review F9），组件侧按需引回。
import { approvalActionsMotion, type CardPhase } from './_cardShell.lib'

/** The pill phase = the derived CardPhase, plus `approving` — a UI-only state that exists while a
 *  decision is in flight (the approve/reject handler's promise has not settled: an edit-tier
 *  resolve POST, PendingApprovalPanel's server-side /decide resume). It is NOT a CardPhase because
 *  nothing in the tool part carries it; ApprovalActions reports it up through CardShellContext.
 *
 *  🔴 对照 beUI 的 7 态（同名≠同义，别照抄）：
 *    pending→pending · approving→approving(本轮补) · approved/running→authorized（**有意合并**）·
 *    denied→rejected · complete→done · error→error。
 *    `expired`（审批 TTL 过期 / 被取消）是我们**多**出来的一态，beUI 没有对应物。
 *
 *  🔴 为什么 approved 与 running 合并（别被 `status` 骗了去拆它）：tool part 上确实还有 `status`，
 *    且它的值在这个窗口里**会变**（requires-action → running），乍看能把两者分开。不能用 ——
 *    assistant-ui 的 `toMessagePartStatus` 对**尚无 result** 的 tool part 直接返回**整条 message 的**
 *    status（core/runtime/api/message-runtime.js），所以 `running` 的含义是「这轮助手回复还在流式
 *    输出」，不是「这个工具正在执行」。拿它当 per-tool 执行态是范畴错误：同一条消息里所有未完成的
 *    工具都会同时读成 running，而 detached run 下流断开时正在服务端执行的工具反而读不到 running。
 *    真正的 per-tool 执行信号只有 `result`/`isError`（→ done/error）与 `timing`（startedAt 在**参数
 *    流式**阶段就已置位，早于审批，同样区分不了）。故合并，而不是拆出一个恒不可信的态。 */
type CardPillPhase = CardPhase | 'approving'

const PHASE_PILL: Record<CardPillPhase, { labelKey: string; klass: string }> = {
  pending: { labelKey: 'chat.approvalShell.phase.pending', klass: 'bg-coral/15 text-coral' },
  approving: { labelKey: 'chat.approvalShell.phase.approving', klass: 'bg-info/15 text-info' },
  authorized: { labelKey: 'chat.approvalShell.phase.authorized', klass: 'bg-info/15 text-info' },
  done: { labelKey: 'chat.approvalShell.phase.done', klass: 'bg-ok/15 text-ok' },
  rejected: { labelKey: 'chat.approvalShell.phase.rejected', klass: 'bg-ink-3 text-ink-fg-2' },
  expired: { labelKey: 'chat.approvalShell.phase.expired', klass: 'bg-ink-3 text-ink-fg-2' },
  error: { labelKey: 'chat.approvalShell.phase.error', klass: 'bg-fail/15 text-fail' }
}

/** What CardFrame publishes to the shell pieces nested in its body. Absent (a piece rendered
 *  outside a CardFrame — PendingApprovalPanel uses ApprovalActions standalone) → the pieces behave
 *  as if pending, i.e. exactly as before this context existed. */
interface CardShellCtx {
  phase: CardPhase
  /** ApprovalActions reports its in-flight decision so the frame can swap the pill to `approving`. */
  setDeciding: (deciding: boolean) => void
}
const CardShellContext = createContext<CardShellCtx | null>(null)

/** The shared card frame: an accent-bordered surface with an icon, title, the phase pill, and
 *  the card-specific body. Used by all three rich cards so they read as one family. */
export function CardFrame({
  icon,
  title,
  phase,
  children
}: {
  icon: React.ReactNode
  title: string
  phase: CardPhase
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  // A3 — `deciding` only ever refines the PENDING pill; every other phase reads straight through,
  // so a latched value can never leak into a terminal state (no reset effect needed).
  const [deciding, setDeciding] = useState(false)
  const pill = PHASE_PILL[phase === 'pending' && deciding ? 'approving' : phase]
  const ctx = useMemo<CardShellCtx>(() => ({ phase, setDeciding }), [phase])
  // 主题 v3 C8/批 4: 卡片档圆角 rounded-xl(12) → token 化 --r-card
  return (
    <CardShellContext.Provider value={ctx}>
      <div className="my-1.5 min-w-0 overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1">
        <div className="flex items-center gap-2 border-b border-ink-border-soft px-3 py-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink-3 text-coral">
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">{title}</span>
          <span
            className={cn('shrink-0 rounded-full px-2 py-0.5 text-meta font-medium', pill.klass)}
          >
            {t(pill.labelKey)}
          </span>
        </div>
        <div className="px-3 py-2.5">{children}</div>
      </div>
    </CardShellContext.Provider>
  )
}

/** A2 — one reviewable parameter: a label cell + a value cell. */
export interface CardParam {
  id: string
  label: React.ReactNode
  value: React.ReactNode
  /** Machine-ish value (id / path / tool name) → mono + break-all. */
  mono?: boolean
  /** The value the review hinges on (the proposed change) → medium weight. */
  accent?: boolean
}

/** A2 (beUI tool-approval) — the shared parameter table: a two-column `<dl>` grid so every card's
 *  参数区 lines up the same way instead of each card hand-rolling a flex row. Semantics matter as
 *  much as the alignment: `<dt>`/`<dd>` tell a screen reader which value belongs to which label,
 *  which the old anonymous `<span>` pairs did not. Empty list → renders nothing.
 *
 *  🔴 The grid lives on the `<dl>` and every `<dt>`/`<dd>` is a DIRECT child of it (hence the
 *  `Fragment` — a per-row wrapper `<div>` would make each row its OWN grid). That is the invariant
 *  CalendarApprovalCard's 原时间/新时间 rows depend on: two rows of ONE grid share a column, so the
 *  two timestamps start at the same x and the card reads as a literal before→after diff. The flex
 *  version this replaced let each label size itself and the timestamps landed 19px apart.
 *
 *  🔴 First track is `auto`, NOT a fixed width. It used to be `minmax(0,5.5rem)` (88px) with a
 *  `truncate` on the `<dt>`, which left ~7px of slack under the longest en-US label ("Current
 *  time" ≈ 81px): a different font, a bumped system text size or one longer label would have
 *  silently clipped a SAFETY label to "Current tim…" on a calendar-reschedule approval. An `auto`
 *  track is sized by its widest label and can never clip; the value column keeps `minmax(0,1fr)`
 *  so a long value still wraps instead of overflowing. */
export function CardParams({
  items,
  className
}: {
  items: CardParam[]
  className?: string
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <dl
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 text-aux',
        className
      )}
    >
      {items.map((p) => (
        <Fragment key={p.id}>
          <dt className="text-ink-fg-2">{p.label}</dt>
          <dd
            className={cn(
              'min-w-0 break-words text-ink-fg',
              p.mono === true && 'break-all font-mono',
              p.accent === true && 'font-medium'
            )}
          >
            {p.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** A4 (beUI tool-approval) — the collapsible review detail.
 *
 *  🔴 Starts OPEN, unlike beUI's `defaultOpen: false`: while a card is pending, what the user is
 *  about to approve MUST be on screen without a click. The collapse only fires on the
 *  pending → 非 pending transition (the decision has landed → fold the bulk away so a long thread
 *  isn't wallpapered with settled payloads); the user can re-expand at any time. A card mounted
 *  straight into a terminal phase (reloaded history) never saw the transition and stays open.
 *
 *  Consequence for the caller: this must be rendered OUTSIDE the phase branches, otherwise the
 *  host unmounts it at the decision and there is nothing left to collapse. */
export function CardDetails({
  children,
  label
}: {
  children: React.ReactNode
  label?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const reduce = useReducedMotion() ?? false
  const phase = useContext(CardShellContext)?.phase ?? 'pending'
  const detailsId = useId()
  const [open, setOpen] = useState(true)
  const prevPhase = useRef(phase)
  useEffect(() => {
    if (prevPhase.current === 'pending' && phase !== 'pending') setOpen(false)
    prevPhase.current = phase
  }, [phase])
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="mt-1 inline-flex items-center gap-1 rounded-md text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
      >
        {label ?? t('chat.approvalShell.details')}
        <motion.span
          aria-hidden="true"
          className="inline-flex"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
        >
          <ChevronDown size={12} strokeWidth={2} />
        </motion.span>
      </button>
      {open ? <div id={detailsId}>{children}</div> : null}
    </>
  )
}

/** The approve / reject action row shown while a card is pending. `onApprove` may be async
 *  (edit-tier first POSTs the edit); a thrown error is surfaced inline and the approval is NOT
 *  sent. P2-1 (codex r1) — `onReject` may be async too (server-side /decide): BOTH buttons route
 *  through the SAME busy/error state machine, so a rejected reject-Promise surfaces inline instead
 *  of becoming an unhandled rejection while the card silently stays live. `approveLabel` defaults
 *  to the localized approve label (chat.approvalShell.approve).
 *
 *  A5 — the row lives in an `AnimatePresence` and hides itself once the frame's phase leaves
 *  `pending`, so the decision fades the buttons out instead of blinking them away. 🔴 That only
 *  happens for hosts that render this component OUTSIDE their phase branches (McpApprovalCard /
 *  SimpleApprovalCard): a host that keeps it inside `phase === 'pending' ? …` unmounts the
 *  presence root together with the row, which is the pre-A5 behaviour, byte-for-byte. Rendered
 *  without a CardFrame (PendingApprovalPanel) the phase reads `pending` → always visible, also
 *  unchanged. */
export function ApprovalActions({
  onApprove,
  onReject,
  approveLabel,
  disabled
}: {
  onApprove: () => void | Promise<void>
  onReject: () => void | Promise<void>
  approveLabel?: string
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const reduce = useReducedMotion() ?? false
  const shell = useContext(CardShellContext)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anim = approvalActionsMotion(reduce)
  // Shared async action machine: busy disables the pair while either action is in flight; a throw
  // renders inline and re-enables. On success busy stays latched — the card transitions/unmounts.
  const runAction = async (action: () => void | Promise<void>): Promise<void> => {
    setBusy(true)
    shell?.setDeciding(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      shell?.setDeciding(false)
    }
  }
  const visible = (shell?.phase ?? 'pending') === 'pending'
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="approval-actions"
          className="mt-2.5"
          initial={false}
          animate={{ opacity: 1 }}
          exit={anim.exit}
          transition={anim.transition}
        >
          {error && (
            <div className="mb-2 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
              {t('chat.approvalShell.actionFailed', { error })}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            {/* 🔴 The i18n KEY is still `cancel` (renaming it would touch every locale for no
                behaviour); the LABEL is 「拒绝 / Deny」. 0805 收尾③ — this button posts
                `approved: false`, which is an ACTIVE refusal, and the wire condition it produces
                (`approval.approved === false`) already reads「已拒绝 / Denied」on the trace card.
                「取消 / Cancelled」is upstream's word for the OTHER terminal state
                (`resolution ∈ {cancelled, expired}` = nobody ever decided), so spending it here
                left the same event named two different things on two surfaces. */}
            <motion.button
              type="button"
              onClick={() => void runAction(onReject)}
              disabled={busy || disabled}
              whileTap={anim.whileTap}
              transition={SPRING_PRESS}
              className={cn(
                // leading-none: text-aux 的 20px 行高在 28px 按钮里因 CJK half-leading 视觉偏高，
                // 去掉行高让 flex 居中的是字形本身（两个按钮一致）。
                'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2.5 text-aux leading-none',
                'border border-ink-border-soft bg-ink-2 text-ink-fg',
                'transition-colors duration-fast hover:bg-ink-3 disabled:opacity-40'
              )}
            >
              <X size={12} strokeWidth={2.5} />
              {t('chat.approvalShell.cancel')}
            </motion.button>
            <motion.button
              type="button"
              onClick={() => void runAction(onApprove)}
              disabled={busy || disabled}
              whileTap={anim.whileTap}
              transition={SPRING_PRESS}
              className={cn(
                'inline-flex h-7 items-center justify-center gap-1 rounded-md px-3 text-aux font-medium leading-none',
                'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
                'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
              )}
            >
              {busy ? (
                <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />
              ) : (
                <Check size={12} strokeWidth={2.5} />
              )}
              {approveLabel ?? t('chat.approvalShell.approve')}
            </motion.button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** A small terminal-state banner (rejected / expired) shown in place of the action row. */
export function TerminalBanner({ phase }: { phase: CardPhase }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (phase === 'rejected') {
    return (
      <div className="mt-2 text-meta text-ink-fg-2">{t('chat.approvalShell.rejectedBanner')}</div>
    )
  }
  if (phase === 'expired') {
    return (
      <div className="mt-2 text-meta text-ink-fg-2">{t('chat.approvalShell.expiredBanner')}</div>
    )
  }
  return null
}

/** The default approval-gate icon for the generic card. */
export function ApprovalIcon(): React.JSX.Element {
  return <ShieldQuestion size={13} strokeWidth={2} />
}
