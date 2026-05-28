// Phase C — folder 写操作二次确认 dialog. Sprint 18 视觉重写 →
// ref/mockup-archive.html + mockup-drafts.html 的 .modal: glass-pop + backdrop
// blur + scale/translate 入场动画 + icon 徽 (danger/accent) + 带 bg tint 的
// 底部按钮栏。focus-trap + Esc 行为复刻 EmailToolbar 的 ResyncConfirmDialog
// (createPortal + useFocusTrap)。prefers-reduced-motion 时 CSS 关动画。
//
// kind 决定图标徽与确认按钮基色:
//   move        → accent 徽, primary 确认
//   send        → accent 徽, primary 确认 (措辞强调真实发出)
//   delete/deleteDraft → fail 徽, solid danger 确认
// extra 槽放收件人 chips (send) / 不可恢复 callout (delete) 等富内容。

import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Send, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'

export type ConfirmKind = 'move' | 'delete' | 'send' | 'deleteDraft'

interface Props {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  /** 决定图标徽 + 确认按钮基色。未传则按 danger 推断 fall back。 */
  kind?: ConfirmKind
  /** danger=true → 确认按钮用 fail 危险样式 (删除/发送); 否则中性 primary。 */
  danger?: boolean
  /** 标题/正文下方的富内容槽 (收件人 chips / 警告 callout)。 */
  extra?: React.ReactNode
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

function KindIcon({ kind, size = 20 }: { kind: ConfirmKind; size?: number }): React.ReactElement {
  if (kind === 'move') return <ArrowLeft size={size} strokeWidth={1.9} />
  if (kind === 'send') return <Send size={size} strokeWidth={1.9} />
  return <Trash2 size={size} strokeWidth={1.9} />
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  kind,
  danger,
  extra,
  pending,
  onConfirm,
  onCancel
}: Props): React.ReactElement | null {
  const { dialogRef, handleTab } = useFocusTrap({ open })
  // 退场延迟卸载：backdrop(root) 淡入 + .folder-modal 位移缩放。GSAP 接管进/退
  // 两端，故 index.css 移除了 .folder-modal-rise/-fade（同时消除旧第二曲线）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '.folder-modal'
  })

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

  if (!shouldRender) return null

  const resolvedKind: ConfirmKind = kind ?? (danger ? 'delete' : 'move')
  const isDestructive = resolvedKind === 'delete' || resolvedKind === 'deleteDraft'
  const icoTone = isDestructive ? 'is-danger' : 'is-accent'
  const confirmTone = isDestructive ? 'gbtn-danger-solid' : 'gbtn-primary'

  return createPortal(
    <div
      ref={scopeRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="folder-modal-backdrop"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div ref={dialogRef} onClick={(e) => e.stopPropagation()} className="folder-modal glass-pop">
        <div className="p-5 flex items-start gap-4">
          <div className={cn('folder-modal-ico', icoTone)}>
            <KindIcon kind={resolvedKind} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lead font-semibold text-ink-fg mb-1.5">{title}</h2>
            <div className="text-aux text-ink-fg-1 leading-relaxed">{body}</div>
            {extra && <div className="mt-3">{extra}</div>}
          </div>
        </div>
        <div className="px-5 py-3.5 border-t border-ink-border-soft flex items-center justify-end gap-2 bg-ink-1/30">
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn('gbtn', confirmTone)}
            onClick={onConfirm}
            disabled={pending}
          >
            <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
              <KindIcon kind={resolvedKind} size={13} />
            </span>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
