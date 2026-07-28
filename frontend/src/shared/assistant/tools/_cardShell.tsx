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
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { resolveAiGatewayBaseUrl } from '../runtime/flags'

/** The lifecycle phase a write-tool card is in, derived from the live tool part. Drives both
 *  the status pill and which actions are shown (phase-04 §7 UIMessage state → UI table). */
export type CardPhase =
  | 'pending' // approval-requested: the card asks the user to approve / edit / reject
  | 'authorized' // approved, executing or awaiting the result
  | 'done' // output-available: the write ran, show the result
  | 'rejected' // the user rejected (output-denied)
  | 'expired' // the approval was cancelled / expired without a decision
  | 'error' // output-error

/** Derive the card phase from the assistant-ui tool part props. The `approval` gate (approved
 *  undefined + no resolution) is the pending signal; `result`/`isError`/`status` cover the
 *  terminal states. Robust to a reloaded part that carries only a result (no live approval). */
export function deriveCardPhase(
  props: Pick<ToolCallMessagePartProps, 'approval' | 'result' | 'isError' | 'status'>
): CardPhase {
  const { approval, result, isError, status } = props
  if (isError === true || (status?.type === 'incomplete' && status.reason === 'error')) {
    return 'error'
  }
  if (approval?.resolution === 'cancelled' || approval?.resolution === 'expired') return 'expired'
  if (approval && approval.approved === false) return 'rejected'
  if (result !== undefined && result !== null) return 'done'
  // approval gate still open (approved === undefined, no resolution) → ask the user.
  if (approval && approval.approved === undefined) return 'pending'
  // approved but no result yet (executing), or a reloaded part with neither — treat as
  // authorized/running so the card shows a calm "running" state rather than empty.
  return approval?.approved === true ? 'authorized' : 'done'
}

/** Longest error detail a card will render — a schema-validation errorText embeds the whole
 *  rejected input, which for a draft is the entire body. */
const ERROR_DETAIL_MAX = 240

/** Pull a SHORT, actionable line out of a failed tool part, or null when there is nothing better
 *  than the card's generic sentence (issue #70 — 8 identical "草稿操作失败，请重试" cards told the
 *  user nothing, while the part carried the exact reason all along).
 *
 *  assistant-ui delivers a tool-error part as `result = { error: <errorText> }` (react-ai-sdk
 *  convertMessage). Two errorText shapes reach us:
 *    - a domain failure, already short and coded: `[E_KOS_NETWORK] MCP request failed: …`;
 *    - an ai@7 input-validation failure, where the useful part is the zod issue list buried
 *      after `Error message:` and behind a full JSON dump of the rejected input.
 *  The second is unwrapped to `field: message`; anything else is passed through and clamped. */
export function toolErrorDetail(result: unknown): string | null {
  const raw =
    typeof result === 'string'
      ? result
      : typeof (result as { error?: unknown } | null)?.error === 'string'
        ? (result as { error: string }).error
        : null
  if (raw == null) return null
  const text = raw.trim()
  if (text.length === 0) return null

  const marker = text.indexOf('Error message:')
  if (marker >= 0) {
    const tail = text.slice(marker + 'Error message:'.length).trim()
    try {
      const issues: unknown = JSON.parse(tail)
      if (Array.isArray(issues) && issues.length > 0) {
        const first = issues[0] as { path?: unknown; message?: unknown }
        const message = typeof first.message === 'string' ? first.message : null
        if (message != null) {
          const path = Array.isArray(first.path) ? first.path.join('.') : ''
          const one = path.length > 0 ? `${path}: ${message}` : message
          const more = issues.length > 1 ? ` (+${issues.length - 1})` : ''
          return clampDetail(one + more)
        }
      }
    } catch {
      /* not the zod shape — fall through to the raw text */
    }
  }
  return clampDetail(text)
}

function clampDetail(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > ERROR_DETAIL_MAX ? `${one.slice(0, ERROR_DETAIL_MAX)}…` : one
}

/** POST the user's edited fields to the gateway resolve side-channel (edit-tier only). The
 *  gateway overlays them onto the pending approval's original input (identity pinned) so the
 *  next streamText call's execute runs the edit — WITHOUT changing the ai@6 history input, so
 *  the signed approval stays valid. Resolves on 2xx; throws with the typed error code on
 *  failure so the card can surface it and NOT proceed to approve. */
export async function postApprovalEdit(
  toolCallId: string,
  editedInput: Record<string, unknown>
): Promise<void> {
  const base = resolveAiGatewayBaseUrl()
  // `''` (same-origin web proxy) is a VALID base but falsy — null-check explicitly, never `!base`.
  if (base == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${base}/api/ai/approval/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId, editedInput })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(code)
  }
}

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
