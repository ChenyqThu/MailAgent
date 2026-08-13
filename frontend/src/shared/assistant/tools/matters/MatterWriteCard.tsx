// Matters MVP P3 (lane ③) — the matter write tools' message-part card.
//
// ONE component for all 9 matter write tools, routing by phase — deliberately, because the same
// tool part passes through both surfaces of this feature:
//
//   pending / rejected / expired → SimpleApprovalCard (D7: identity-level approval is enough).
//       🔴 Without a registered card these edit-tier writes fall through to the BUTTONLESS
//       ToolTraceCard, which renders approval-paused as a permanent spinner — the v1.5.0 / G9
//       islandless deadlock. matter_resource_mutate can force a card at any time (access_policy →
//       allowed, adjudication #1), and per-tool prefs let an owner set any of the 9 to `ask`.
//   done + inside a Matter Chat panel → the write receipt (「已写入 · {写入描述}」 + 撤销), design 附录 C.
//   everything else (done in普通 chat, authorized, error) → the generic ToolTraceCard, byte-identical
//       to what these tools rendered before this card existed.
//
// 🔴 9 is THIS CARD's vocabulary (WRITE_LABELLED_TOOLS below + the 9 matters.chat.writeLabels keys
// in both locales). ComponentRegistry registers it for only SEVEN — matter_run_control /
// matter_review_update (P4) were never added there, so this card never mounts for those two and
// they still take the buttonless fall-through described above. See the 🔴 note at the registration
// entry; fixing it is a behaviour change, tracked separately.
//
// 🔴 The receipt's headline describes THE WRITE, keyed off the tool name (matters.chat.writeLabels).
// It deliberately does NOT use `undo.label`: the service builds that label to name the REVERSE
// operation (「撤销事项更新」), so showing it after 「已写入 ·」 reads as if the undo had already
// happened. undo.label keeps its correct job — it is the undo action's own description, surfaced on
// the 撤销 button's tooltip.
//
// The receipt's undo is renderer-direct REST (no LLM, no new message) — the handler lives on the
// panel via MatterChatSurfaceContext; this card only renders its state.

import { useTranslation } from 'react-i18next'
import { Briefcase, FileCheck2, Loader2, RotateCcw } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import {
  readUndoDescriptor,
  useMatterChatSurface
} from '@shared/components/matters/matterChatContext'

import { deriveCardPhase } from '../_cardShell.lib'
import { SimpleApprovalCard } from '../generic/SimpleApprovalCard'
import { ToolTraceCard } from '../generic/ToolTraceCard'

/** The 9 matter write tools that have a `matters.chat.writeLabels.<tool>` headline. Membership is
 *  checked (rather than blindly interpolating the tool name into the key) so an unregistered /
 *  renamed tool degrades to the undo label → generic 「已写入」, never to a raw i18n key on screen. */
const WRITE_LABELLED_TOOLS = new Set([
  'matter_create',
  'matter_update',
  'matter_item_mutate',
  'matter_resource_mutate',
  'matter_stakeholder_mutate',
  'matter_relation_mutate',
  'matter_add_note',
  'matter_run_control',
  'matter_review_update'
])

export function MatterWriteCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const surface = useMatterChatSurface()
  const phase = deriveCardPhase(props)

  if (phase === 'pending' || phase === 'rejected' || phase === 'expired') {
    return <SimpleApprovalCard {...props} />
  }

  if (surface === null || phase !== 'done') return <ToolTraceCard {...props} />

  const descriptor = readUndoDescriptor(props.result)
  const state = surface.undoStates[props.toolCallId] ?? 'idle'
  const undone = state === 'done'
  // What was written (by tool) → the undo's own wording → nothing but 「已写入」.
  const writeLabel = WRITE_LABELLED_TOOLS.has(props.toolName)
    ? t(`matters.chat.writeLabels.${props.toolName}`)
    : (descriptor?.label ?? null)

  return (
    <div
      data-testid="matter-write-receipt"
      className={cn(
        'mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-2 text-aux',
        undone
          ? 'border-ink-border bg-ink-3/70 text-ink-fg-2'
          : 'border-ok/25 bg-ok/[0.07] text-ink-fg-1'
      )}
    >
      {undone ? (
        <RotateCcw size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
      ) : (
        <FileCheck2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
      )}
      <span className="min-w-0 flex-1 text-pretty">
        {undone
          ? t('matters.chat.receipt.undone')
          : writeLabel === null
            ? t('matters.chat.receipt.written')
            : t('matters.chat.receipt.writtenWithLabel', { label: writeLabel })}
      </span>
      {!undone && descriptor !== null ? (
        <button
          type="button"
          disabled={state === 'busy'}
          // undo.label describes the REVERSE operation — exactly right as this button's tooltip.
          title={descriptor.label}
          onClick={() => surface.runUndo(props.toolCallId, descriptor)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-aux text-coral',
            'transition-colors duration-fast hover:bg-coral/10 disabled:opacity-50'
          )}
        >
          {state === 'busy' ? <Loader2 size={11} className="animate-spin" /> : null}
          {t('matters.chat.receipt.undo')}
        </button>
      ) : null}
      <Briefcase size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" aria-hidden />
    </div>
  )
}
