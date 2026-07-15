// Compose confirm dialogs — Send (irreversible) + Discard (unsaved loss).
//
// Built on the shadcn Radix Dialog wrapper (`ui/dialog.tsx`) which already
// supplies the glass-pop content + backdrop + ESC / overlay-click close +
// focus trap. Visuals follow mockup-draft-composer.html's #modal-send /
// #modal-discard: accent icon badge + recipient chips + SMTP warning (send);
// danger icon + unsaved-loss warning (discard).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Send, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

function chipInitials(addr: string): string {
  const at = addr.split('@')[0] ?? addr
  return (at.slice(0, 2) || '?').toUpperCase()
}

interface SendProps {
  open: boolean
  to: string[]
  cc: string[]
  bcc: string[]
  attachments: number
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function SendConfirmDialog({
  open,
  to,
  cc,
  bcc,
  attachments,
  pending,
  onConfirm,
  onCancel
}: SendProps): React.ReactElement {
  const { t } = useTranslation()
  const allRecipients = [...to, ...cc, ...bcc]
  const recipientCount = allRecipients.length
  // 收件人多时分两段展示：默认只渲染前 VISIBLE 个 chip + 「+N more」按钮，
  // 点击后展开全部。配合 DialogContent 的 max-h-[85vh] + 中段 overflow-y-auto，
  // 任意数量收件人都不会把 footer 的 Send 按钮挤出视口。
  const [showAll, setShowAll] = useState(false)
  const VISIBLE = 8
  const visibleRecipients = showAll ? allRecipients : allRecipients.slice(0, VISIBLE)
  const hiddenCount = recipientCount - VISIBLE

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      {/* grid-rows-[auto_1fr_auto] 依赖恰好 3 个直接 grid 子 (header / 滚动区 /
          footer)；将来在 DialogContent 下再加第 4 个直接子会破坏行映射、重新溢出。 */}
      <DialogContent className="max-w-[460px] max-h-[85vh] grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[var(--r-card)] grid place-items-center shrink-0',
                'text-coral bg-coral/[0.12] border border-coral/30'
              )}
            >
              <Send size={20} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('compose.sendConfirm.title', { n: recipientCount })}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">
                {t('compose.sendConfirm.body')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* 中段 (1fr 行) 可滚动：min-h-0 让 grid 子项允许收缩到内容以下,
            overflow-y-auto 在收件人超量时给 chip 区滚动条而非撑高弹窗。 */}
        <div className="min-h-0 overflow-y-auto">
          {recipientCount > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-[58px]">
              {visibleRecipients.map((addr, i) => (
                <span key={`${addr}-${i}`} className="recipient-chip">
                  <span className="rc-av">{chipInitials(addr)}</span>
                  <span className="break-all">{addr}</span>
                </span>
              ))}
              {recipientCount > VISIBLE && !showAll && (
                <button type="button" className="recipient-chip" onClick={() => setShowAll(true)}>
                  {t('compose.sendConfirm.moreRecipients', { n: hiddenCount })}
                </button>
              )}
            </div>
          )}

          {attachments > 0 && (
            <div className="pl-[58px] mt-1.5 text-meta font-mono text-ink-fg-2">
              {t('compose.sendConfirm.attachments', { n: attachments })}
            </div>
          )}
        </div>

        <DialogFooter>
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel} disabled={pending}>
            {t('compose.cancel')}
          </button>
          <button
            type="button"
            className="gbtn gbtn-primary"
            onClick={onConfirm}
            disabled={pending}
          >
            <Send size={13} strokeWidth={2} />
            {t('compose.sendConfirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteDraftProps {
  open: boolean
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 草稿删除二次确认 — 删草稿改 DB (IMAP \Deleted + 本地行清理), 不可逆。reply/forward
 *  的「丢弃」是临时撰写内容、未持久化, 直接关闭不走此弹窗。 */
export function DeleteDraftDialog({
  open,
  pending,
  onConfirm,
  onCancel
}: DeleteDraftProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[var(--r-card)] grid place-items-center shrink-0',
                'text-fail bg-fail/10 border border-fail/30'
              )}
            >
              <Trash2 size={20} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('compose.deleteConfirm.title')}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">
                {t('compose.deleteConfirm.body')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel} disabled={pending}>
            {t('compose.cancel')}
          </button>
          <button
            type="button"
            className="gbtn gbtn-danger-solid"
            onClick={onConfirm}
            disabled={pending}
          >
            <Trash2 size={13} strokeWidth={2} />
            {t('compose.deleteConfirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface UnsavedProps {
  open: boolean
  /** save-draft-then-proceed in flight — disables all three actions + spins Save. */
  pending: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** 离开确认 (Bug C / T6) — composer 有未保存更改时, 关闭 (ESC / 丢弃 / 切邮件 /
 *  新邮件浮窗 scrim·×) 前弹此三键确认: 保存草稿 (存后继续原动作) / 丢弃 (直接继续) /
 *  取消 (留在 composer)。与 SendConfirmDialog 同 glass-pop + --r-pop 材质。overlay/ESC
 *  点击关闭 = 取消语义 (onOpenChange → onCancel)。 */
export function UnsavedChangesDialog({
  open,
  pending,
  onSave,
  onDiscard,
  onCancel
}: UnsavedProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[var(--r-card)] grid place-items-center shrink-0',
                'text-warn bg-warn/[0.12] border border-warn/30'
              )}
            >
              <Save size={20} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('compose.unsaved.title')}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">
                {t('compose.unsaved.body')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          {/* 丢弃 = 危险 (bare, 但 danger 前景) 靠左; 取消居中; 保存草稿主行动靠右。 */}
          <button
            type="button"
            className="gbtn gbtn-bare text-fail mr-auto"
            onClick={onDiscard}
            disabled={pending}
          >
            <Trash2 size={13} strokeWidth={2} />
            {t('compose.unsaved.discard')}
          </button>
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel} disabled={pending}>
            {t('compose.unsaved.cancel')}
          </button>
          <button type="button" className="gbtn gbtn-primary" onClick={onSave} disabled={pending}>
            {pending ? (
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <Save size={13} strokeWidth={2} />
            )}
            {t('compose.unsaved.save')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
