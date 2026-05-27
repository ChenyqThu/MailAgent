// Phase C — folder 写操作二次确认 dialog. 删除 / 移回 / 发送都不可逆 (或
// 对外不可逆), 强制弹确认。视觉 + focus-trap + Esc 行为复刻 EmailToolbar 的
// ResyncConfirmDialog (createPortal + useFocusTrap)。

import { useCallback } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@shared/lib/cn'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'

interface Props {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  /** danger=true → confirm 按钮用 coral 危险样式 (删除/发送); 否则中性。 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel
}: Props): React.ReactElement | null {
  const { dialogRef, handleTab } = useFocusTrap({ open })

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      handleTab(e)
    },
    [onCancel, handleTab]
  )

  if (!open) return null
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-[440px] rounded-lg bg-ink-2 border border-ink-border p-5',
          'shadow-[0_8px_24px_rgba(0,0,0,0.35)]'
        )}
      >
        <h2 className="text-lead text-ink-fg font-semibold mb-2">{title}</h2>
        <p className="text-aux text-ink-fg-1 mb-5 leading-relaxed">{body}</p>
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'px-3 py-1.5 rounded-md text-aux text-ink-fg-1',
              'hover:bg-ink-4 transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-coral/60'
            )}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'px-3 py-1.5 rounded-md text-aux font-medium transition-colors duration-fast',
              danger
                ? 'bg-coral/100 text-accent-fg hover:bg-coral-hover focus:ring-2 focus:ring-accent-fg/40'
                : 'text-ink-fg border border-ink-border hover:bg-ink-4 focus:ring-2 focus:ring-coral/60',
              'focus:outline-none'
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
