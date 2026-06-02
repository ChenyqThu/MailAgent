// Sprint 19 PR-1d.2 — Confirmation dialog for write-class agent tools.
//
// Mounts ONCE per `PendingConfirmation` entry in useEmailChat. The harness
// in the main process is blocked on a per-toolUseId promise until the user
// clicks Confirm or Cancel; the click → chat.confirmTool IPC unblocks it.
//
// Three render shapes:
//   tier='preview' (email_flag / email_archive) — read-only JSON dump of
//     the input with a 1-line preview banner. OK / Cancel buttons.
//   tier='edit' (email_draft_reply) — same banner + editable textarea for
//     the body field. The submitted value diff-checks against the proposed
//     body; if changed, we hand the edited input back to the harness via
//     editedInput so the tool handler sees the user's words verbatim.
//   tier=other — fallback to preview shape; future tiers slot in here.
//
// Keyboard:
//   Escape          → Cancel (matches macOS sheet idiom)
//   Cmd+Return      → Confirm (mirrors the Composer's Cmd+Return Send)
//
// Why this lives in shared/components/chat rather than next to MessageList:
//   it's a top-level overlay anchored to the panel root, not a nested
//   message-row affordance. ChatPanel owns the queue render loop.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Focus the textarea (edit tier) or the Confirm button (preview tier)
  // when the dialog mounts so keyboard users can act immediately.
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (editable) textareaRef.current?.focus()
    else confirmBtnRef.current?.focus()
  }, [editable])

  // 进场动画：backdrop 淡入 + 卡片位移缩放，消除原硬出现的 "AI slop" 感。
  // 退场不做（父 AIChatPanel 按 pending 队列硬卸载，且由用户点 Confirm/Cancel
  // 主动触发，瞬时消失符合预期）——故此处用 useGSAP 进场而非 useExitAnimation。
  const rootRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  useGSAP(
    () => {
      if (reduce) return
      const root = rootRef.current
      if (!root) return
      const card = root.querySelector<HTMLElement>('[data-anim-card]')
      const tl = gsap.timeline()
      tl.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast }, 0)
      if (card) {
        tl.fromTo(
          card,
          { autoAlpha: 0, y: 8, scale: 0.97 },
          { autoAlpha: 1, y: 0, scale: 1, clearProps: 'transform' },
          0
        )
      }
    },
    { scope: rootRef, dependencies: [reduce] }
  )

  const handleConfirm = useCallback(async () => {
    if (busy) return
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
  }, [busy, editable, editedBody, onConfirm, pending.input])

  const handleCancel = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await onCancel()
    } finally {
      setBusy(false)
    }
  }, [busy, onCancel])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void handleCancel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleConfirm, handleCancel])

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-tool-${pending.toolUseId}`}
    >
      <div
        data-anim-card
        className={cn(
          'w-[480px] max-w-[92vw] rounded-lg border border-ink-border-soft',
          // no-heavy-shadow: shadow-xl 超出设计系统; dialog 用 DESIGN.md §4.3
          // level-1 raised shadow (detached element 的标准 elevation)。
          'bg-ink-2 shadow-[0_8px_24px_rgba(0,0,0,0.35)] overflow-hidden'
        )}
      >
        {/* Header — tool name + tier badge */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-ink-border-soft bg-ink-3/60">
          <div className="flex items-center gap-2">
            <span
              id={`confirm-tool-${pending.toolUseId}`}
              className="text-meta font-mono uppercase tracking-wider text-ink-fg-1"
            >
              {t('chat.confirmTool.title', { defaultValue: 'Confirm action' })}
            </span>
            <span className="text-meta font-mono text-ink-fg-2">→ {pending.toolName}</span>
          </div>
          <span
            className={cn(
              'text-meta font-mono px-1.5 py-0.5 rounded',
              pending.tier === 'edit' ? 'bg-coral/15 text-coral' : 'bg-ink-fg-3/15 text-ink-fg-2'
            )}
          >
            {pending.tier}
          </span>
        </div>

        {/* Preview banner */}
        {pending.preview && (
          <div className="px-4 py-2 text-aux text-ink-fg border-b border-ink-border-soft bg-ink-3/30">
            {pending.preview}
          </div>
        )}

        {/* Body — editable textarea or read-only JSON */}
        <div className="px-4 py-3">
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
                disabled={busy}
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
            <pre
              className={cn(
                'text-aux font-mono whitespace-pre-wrap break-all',
                'rounded border border-ink-border-soft bg-ink-3 px-2 py-1.5',
                'max-h-[280px] overflow-auto'
              )}
            >
              {safeStringify(pending.input)}
            </pre>
          )}
        </div>

        {/* Footer — Cancel + Confirm */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-ink-border-soft bg-ink-3/40">
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
              'h-7 px-3 rounded text-aux font-medium',
              // AI-CHAT-02: text-white on coral = 2.38:1 (AA fail). Use the
              // per-mode --c-accent-fg token + the coral-hover utility.
              // bg-coral→bg-coral/100 also clears no-coral-flood (the one CTA).
              'bg-coral/100 text-accent-fg hover:bg-coral-hover',
              'disabled:opacity-50'
            )}
          >
            {busy
              ? t('chat.confirmTool.confirming', { defaultValue: 'Confirming…' })
              : t('chat.confirmTool.confirm', { defaultValue: 'Confirm' })}
          </button>
        </div>
      </div>
    </div>
  )
}
