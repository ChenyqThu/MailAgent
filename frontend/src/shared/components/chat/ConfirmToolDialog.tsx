// Sprint 19 PR-1d.2 — Confirmation card for write-class agent tools.
//
// Mounts ONCE per `PendingConfirmation` entry in useEmailChat. The harness
// in the main process is blocked on a per-toolUseId promise until the user
// clicks Confirm or Cancel; the click → chat.confirmTool IPC unblocks it.
//
// task 06-08-chat Bug 4 — was a fixed inset-0 full-screen overlay with a
// black backdrop; now an INLINE authorization card rendered inside the
// message stream (MessageList, after the streaming assistant turn). The
// confirmation happens while the harness is dispatching a tool, so the
// streaming assistant is the last row — the card reads as "the AI wants to
// run tool X, please authorize" right where it belongs. Width hugs the
// 360px drawer (min-w-0 + content break) and survives the popout layout.
//
// task 06-08-chat PR D (handoff §4) — visual polish to mirror the mockup's
// `.authz` card:
//   §4.2 — shield-icon header (coral chip) + "确认操作" title + → toolName +
//          tier badge (preview→"写操作" gray / edit→"可编辑" coral); the
//          preview-tier input JSON is now collapsed behind a "查看详情"
//          toggle (display-switch, §7) instead of an always-open <pre>.
//   §4.3 — after the user decides, the card LINGERS ~1.3s showing a decided
//          banner (✓ authorized / ✕ rejected) in place of the footer. The
//          lingering is driven by `pending.resolved`, set by the parent's
//          confirmTool the instant the IPC fires — the authorization closure
//          (闭环) is untouched, only the visual removal is delayed.
//
// Three render shapes:
//   tier='preview' (email_flag / email_archive) — collapsed JSON dump of the
//     input (1-line "查看详情" toggle) with a 1-line preview banner.
//     Authorize / Reject buttons.
//   tier='edit' (email_draft_reply) — same banner + editable textarea for the
//     body field (NO details toggle — the textarea IS the main surface). The
//     submitted value diff-checks against the proposed body; if changed, we
//     hand the edited input back to the harness via editedInput so the tool
//     handler sees the user's words verbatim.
//   tier=other — fallback to preview shape; future tiers slot in here.
//
// Keyboard (scoped to the card element, NOT window — an inline card must
// not steal the Composer's keystrokes):
//   Escape          → Cancel (matches macOS sheet idiom)
//   Cmd+Return      → Confirm (mirrors the Composer's Cmd+Return Send)

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Shield, X } from 'lucide-react'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import type { PendingConfirmation } from '@shared/hooks/useEmailChat'

export interface ConfirmToolDialogProps {
  pending: PendingConfirmation
  onConfirm: (editedInput?: unknown) => Promise<void> | void
  onCancel: () => Promise<void> | void
}

/** Extract the field the dialog should expose as a textarea when the tier
 *  is 'edit'. Right now only email_draft_reply has this — `body_markdown`.
 *  Returning null falls back to the JSON read-only render so future
 *  edit-tier tools without a single-field surface still produce something
 *  usable. */
function pickEditableField(
  toolName: string,
  input: unknown
): {
  key: string
  value: string
} | null {
  if (typeof input !== 'object' || input === null) return null
  const obj = input as Record<string, unknown>
  if (toolName === 'email_draft_reply' && typeof obj.body_markdown === 'string') {
    return { key: 'body_markdown', value: obj.body_markdown }
  }
  return null
}

/** Pretty-print JSON for the read-only panel. Falls back to String() on
 *  cyclic or otherwise non-serializable input — never blows the dialog. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ConfirmToolDialog({
  pending,
  onConfirm,
  onCancel
}: ConfirmToolDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const editable =
    pending.tier === 'edit' ? pickEditableField(pending.toolName, pending.input) : null
  const [editedBody, setEditedBody] = useState(editable?.value ?? '')
  const [busy, setBusy] = useState(false)
  // §4.2 — preview-tier input JSON starts collapsed behind a "查看详情" toggle.
  const [showJson, setShowJson] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // §4.3 — once the parent marks this confirmation `resolved`, the card stops
  // accepting input and renders the decided banner instead of the footer.
  const resolved = pending.resolved ?? null

  // Focus the textarea (edit tier) or the Confirm button (preview tier)
  // when the card mounts so keyboard users can act immediately.
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (resolved) return
    if (editable) textareaRef.current?.focus()
    else confirmBtnRef.current?.focus()
  }, [editable, resolved])

  // 进场动画：卡片位移缩放淡入，消除硬出现的 "AI slop" 感。inline 卡无 backdrop
  // (Bug 4 去掉了全屏遮罩)，所以只对卡片本身做进场；退场不做（父按 pending 队列
  // 硬卸载，且由用户点 授权/拒绝 主动触发，瞬时消失符合预期）。
  const rootRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  useGSAP(
    () => {
      if (reduce) return
      const root = rootRef.current
      if (!root) return
      gsap.fromTo(
        root,
        { autoAlpha: 0, y: 8, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: DUR.fast, clearProps: 'transform' }
      )
    },
    { scope: rootRef, dependencies: [reduce] }
  )

  const handleConfirm = useCallback(async () => {
    if (busy || resolved) return
    setBusy(true)
    try {
      if (editable) {
        const merged = {
          ...(pending.input as Record<string, unknown>),
          [editable.key]: editedBody
        }
        // Only flag as edited when the value actually changed — keeps the
        // tool result envelope honest ("user_edited" only when true).
        const changed = editedBody !== editable.value
        await onConfirm(changed ? merged : undefined)
      } else {
        await onConfirm(undefined)
      }
    } finally {
      setBusy(false)
    }
  }, [busy, resolved, editable, editedBody, onConfirm, pending.input])

  const handleCancel = useCallback(async () => {
    if (busy || resolved) return
    setBusy(true)
    try {
      await onCancel()
    } finally {
      setBusy(false)
    }
  }, [busy, resolved, onCancel])

  // Keyboard shortcuts — scoped to the card element (NOT window). As an
  // inline card living in the message stream it must not intercept the
  // Composer's Escape / Cmd+Return; the listener only fires when focus is
  // inside the card (textarea / buttons get auto-focused on mount).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void handleCancel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleConfirm()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [handleConfirm, handleCancel])

  const tierBadge =
    pending.tier === 'edit'
      ? { label: t('chat.confirmTool.tierEdit', { defaultValue: 'Edit' }), tone: 'edit' as const }
      : {
          label: t('chat.confirmTool.tierWrite', { defaultValue: 'Write' }),
          tone: 'write' as const
        }

  return (
    <div
      ref={rootRef}
      // Bug 4 (task 06-08-chat) — inline card in the message stream, NOT a
      // fixed overlay. min-w-0 + content break keep it inside the 360px
      // drawer (same flex `min-width:auto` trap Bug 3 hit). w-full hugs the
      // message column; border + level-1 raised shadow per DESIGN.md §4.3.
      // §4.3 — `resolved` drops the emphasis shadow (mockup `.authz.resolved`).
      className={cn(
        'w-full min-w-0 rounded-lg border border-ink-border-soft overflow-hidden bg-ink-2',
        resolved
          ? 'shadow-none'
          : 'shadow-[0_8px_24px_-10px_rgba(0,0,0,0.35),0_0_0_3px_rgba(229,101,75,0.06)]'
      )}
      role="group"
      aria-labelledby={`confirm-tool-${pending.toolUseId}`}
    >
      {/* §4.2 Header — shield chip + title + → toolName + tier badge */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ink-border-soft bg-ink-3/60">
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded bg-coral/15 text-coral"
          aria-hidden="true"
        >
          <Shield className="h-3 w-3" strokeWidth={2} />
        </span>
        <span
          id={`confirm-tool-${pending.toolUseId}`}
          className="text-meta font-mono uppercase tracking-wider text-ink-fg-1 shrink-0"
        >
          {t('chat.confirmTool.title', { defaultValue: 'Confirm action' })}
        </span>
        <span className="text-meta font-mono text-ink-fg-2 truncate min-w-0">
          → {pending.toolName}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 text-meta font-mono uppercase tracking-wide px-1.5 py-0.5 rounded',
            tierBadge.tone === 'edit' ? 'bg-coral/15 text-coral' : 'bg-ink-fg-3/15 text-ink-fg-2'
          )}
        >
          {tierBadge.label}
        </span>
      </div>

      {/* Preview banner */}
      {pending.preview && (
        <div className="px-3 py-2 text-aux text-ink-fg border-b border-ink-border-soft bg-ink-3/30 break-words">
          {pending.preview}
        </div>
      )}

      {/* Body — editable textarea (edit tier) or collapsible JSON (preview) */}
      <div className="px-3 py-3">
        {editable ? (
          <div className="space-y-1.5">
            <label className="text-meta font-mono text-ink-fg-2">{editable.key}</label>
            <textarea
              ref={textareaRef}
              value={editedBody}
              onChange={(e) => setEditedBody(e.target.value)}
              className={cn(
                'w-full min-h-[140px] max-h-[280px] resize-y',
                'rounded border border-ink-border-soft bg-ink-3',
                'px-2 py-1.5 text-aux text-ink-fg',
                'focus:outline-none focus:ring-2 focus:ring-coral/50 focus:border-coral'
              )}
              disabled={busy || !!resolved}
              spellCheck={false}
            />
            <div className="text-meta text-ink-fg-3">
              {t('chat.confirmTool.editHint', {
                defaultValue:
                  'Edit and Confirm to use your version; the LLM will see what you actually sent.'
              })}
            </div>
          </div>
        ) : (
          <div>
            {/* §4.2 — input JSON collapsed by default; toggle reveals it.
                Folding uses display switch (§7), chevron rotates. */}
            <button
              type="button"
              onClick={() => setShowJson((v) => !v)}
              className="inline-flex items-center gap-1 text-meta font-mono text-ink-fg-2 hover:text-ink-fg-1"
              aria-expanded={showJson}
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 transition-transform motion-reduce:transition-none',
                  showJson && 'rotate-90'
                )}
                strokeWidth={2}
              />
              {t('chat.confirmTool.viewDetails', { defaultValue: 'View details' })}
            </button>
            <pre
              className={cn(
                showJson ? 'block' : 'hidden',
                'mt-2 text-aux font-mono whitespace-pre-wrap break-all',
                'rounded border border-ink-border-soft bg-ink-3 px-2 py-1.5',
                'max-h-[280px] overflow-auto scrollbar-thin'
              )}
            >
              {safeStringify(pending.input)}
            </pre>
          </div>
        )}
      </div>

      {/* §4.3 — decided banner (lingers ~1.3s) OR the action footer. */}
      {resolved ? (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2.5 border-t border-ink-border-soft text-aux font-mono',
            resolved === 'confirmed' ? 'bg-ok/[0.06] text-ok' : 'bg-ink-2 text-ink-fg-2'
          )}
          role="status"
        >
          {resolved === 'confirmed' ? (
            <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          ) : (
            <X className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          )}
          <span className="truncate">
            {resolved === 'confirmed'
              ? t('chat.confirmTool.decidedOk', {
                  defaultValue: 'Authorized · callback received, executing'
                })
              : t('chat.confirmTool.decidedNo', {
                  defaultValue: 'Rejected · no changes made to your mailbox'
                })}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 px-3 py-2.5 border-t border-ink-border-soft bg-ink-3/40">
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className={cn(
              'h-7 px-3 rounded text-aux',
              'border border-ink-border-soft bg-ink-2 text-ink-fg',
              'hover:bg-ink-3 disabled:opacity-50'
            )}
          >
            {t('chat.confirmTool.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={cn(
              'h-7 px-3 rounded text-aux font-medium inline-flex items-center gap-1.5',
              // AI-CHAT-02: text-white on coral = 2.38:1 (AA fail). Use the
              // per-mode --c-accent-fg token + the coral-hover utility.
              // bg-coral→bg-coral/100 also clears no-coral-flood (the one CTA).
              'bg-coral/100 text-accent-fg hover:bg-coral-hover',
              'disabled:opacity-50'
            )}
          >
            <Shield className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
            {busy
              ? t('chat.confirmTool.confirming', { defaultValue: 'Confirming…' })
              : t('chat.confirmTool.confirm', { defaultValue: 'Confirm' })}
          </button>
        </div>
      )}
    </div>
  )
}
