// Recipient chip detail popover — avatar / name / email / internal-external
// badge + edit / copy / remove actions. Opened by clicking a chip or pressing
// Enter on a keyboard-selected chip. Material is the shared `.glass-pop` (float
// rule: blur + --r-pop radius); positioning is fixed-to-viewport off the chip's
// bounding rect so it escapes the chip row's scroll clip.

import { useEffect, useRef } from 'react'
import { Check, Copy, Globe, Pencil, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { RecipientAvatar } from './recipient-avatar'

const POPOVER_W = 272

export interface RecipientDetailContact {
  email: string
  name: string
  external: boolean
  /** false when no internal-domain list is known → hide the internal/external row. */
  determinable: boolean
}

interface Props {
  contact: RecipientDetailContact
  anchorRect: DOMRect
  onClose: () => void
  onEdit: () => void
  onRemove: () => void
}

export function RecipientDetailPopover({
  contact,
  anchorRect,
  onClose,
  onEdit,
  onRemove
}: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Capture-phase Escape so it closes the popover instead of bubbling to the
    // window listener ComposePanel uses to close the whole composer.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return (): void => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 190)
  const left = Math.min(anchorRect.left, window.innerWidth - (POPOVER_W + 16))

  const badgeColor = contact.external ? 'rgb(var(--c-warn))' : 'rgb(var(--c-ok))'
  const BadgeIcon = contact.external ? Globe : Check

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${contact.name || contact.email} 详情`}
      className="glass-pop fixed z-[60] flex flex-col gap-2.5 p-3 text-ink-fg"
      style={{ top, left, width: POPOVER_W }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <RecipientAvatar name={contact.name} email={contact.email} size={38} />
        <div className="min-w-0">
          <div className="text-aux font-medium truncate">{contact.name || contact.email}</div>
          <div className="text-meta font-mono text-ink-fg-2 truncate">{contact.email}</div>
        </div>
      </div>

      {contact.determinable && (
        <div className="flex items-center gap-1.5 text-meta text-ink-fg-2">
          <BadgeIcon size={13} style={{ color: badgeColor }} />
          <span>{contact.external ? '外部联系人' : '内部联系人'}</span>
        </div>
      )}

      <div className="flex items-center gap-1 pt-0.5">
        <button
          type="button"
          onClick={() => {
            onEdit()
            onClose()
          }}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-ctl)] text-meta',
            'text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3'
          )}
        >
          <Pencil size={13} />
          编辑
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(contact.email)
            onClose()
          }}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-ctl)] text-meta',
            'text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3'
          )}
        >
          <Copy size={13} />
          复制
        </button>
        <button
          type="button"
          onClick={() => {
            onRemove()
            onClose()
          }}
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-ctl)] text-meta transition-colors duration-fast ml-auto"
          style={{ color: 'rgb(var(--c-fail))' }}
        >
          <Trash2 size={13} />
          移除
        </button>
      </div>
    </div>
  )
}
