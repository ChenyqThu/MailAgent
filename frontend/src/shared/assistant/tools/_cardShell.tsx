// chat-panel P4 Phase 04a — shared chrome + approval state for the rich A2UI tool cards.
//
// Every rich card (DraftReplyCard / NotionSyncCard / ApprovalActionCard) shares the same
// visual frame (icon + title + status pill + body) and the same HITL wiring (approve / reject
// via assistant-ui's native respondToApproval; edit-tier additionally POSTs the edit to the
// gateway resolve side-channel first). This module owns those shared pieces so each card is
// just "frame + its own body". MailAgent tokens only → reskins across theme × accent for free.


import { useState } from 'react'
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
// 纯逻辑面拆去 _cardShell.lib.ts（08-02 review F9），组件侧按需引回。
import { type CardPhase } from './_cardShell.lib'

const PHASE_PILL: Record<CardPhase, { labelKey: string; klass: string }> = {
  pending: { labelKey: 'chat.approvalShell.phase.pending', klass: 'bg-coral/15 text-coral' },
  authorized: { labelKey: 'chat.approvalShell.phase.authorized', klass: 'bg-info/15 text-info' },
  done: { labelKey: 'chat.approvalShell.phase.done', klass: 'bg-ok/15 text-ok' },
  rejected: { labelKey: 'chat.approvalShell.phase.rejected', klass: 'bg-ink-3 text-ink-fg-2' },
  expired: { labelKey: 'chat.approvalShell.phase.expired', klass: 'bg-ink-3 text-ink-fg-2' },
  error: { labelKey: 'chat.approvalShell.phase.error', klass: 'bg-fail/15 text-fail' }
}

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
  const pill = PHASE_PILL[phase]
  // 主题 v3 C8/批 4: 卡片档圆角 rounded-xl(12) → token 化 --r-card
  return (
    <div className="my-1.5 min-w-0 overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1">
      <div className="flex items-center gap-2 border-b border-ink-border-soft px-3 py-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink-3 text-coral">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">{title}</span>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-meta font-medium', pill.klass)}>
          {t(pill.labelKey)}
        </span>
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  )
}

/** The approve / reject action row shown while a card is pending. `onApprove` may be async
 *  (edit-tier first POSTs the edit); a thrown error is surfaced inline and the approval is NOT
 *  sent. P2-1 (codex r1) — `onReject` may be async too (server-side /decide): BOTH buttons route
 *  through the SAME busy/error state machine, so a rejected reject-Promise surfaces inline instead
 *  of becoming an unhandled rejection while the card silently stays live. `approveLabel` defaults
 *  to the localized approve label (chat.approvalShell.approve). */
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shared async action machine: busy disables the pair while either action is in flight; a throw
  // renders inline and re-enables. On success busy stays latched — the card transitions/unmounts.
  const runAction = async (action: () => void | Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="mt-2.5">
      {error && (
        <div className="mb-2 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
          {t('chat.approvalShell.actionFailed', { error })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void runAction(onReject)}
          disabled={busy || disabled}
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
        </button>
        <button
          type="button"
          onClick={() => void runAction(onApprove)}
          disabled={busy || disabled}
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
        </button>
      </div>
    </div>
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
