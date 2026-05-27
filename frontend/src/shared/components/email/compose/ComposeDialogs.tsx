// Compose confirm dialogs — Send (irreversible) + Discard (unsaved loss).
//
// Built on the shadcn Radix Dialog wrapper (`ui/dialog.tsx`) which already
// supplies the glass-pop content + backdrop + ESC / overlay-click close +
// focus trap. Visuals follow mockup-draft-composer.html's #modal-send /
// #modal-discard: accent icon badge + recipient chips + SMTP warning (send);
// danger icon + unsaved-loss warning (discard).

import { useTranslation } from 'react-i18next'
import { Send, Trash2 } from 'lucide-react'

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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[11px] grid place-items-center shrink-0',
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

        {recipientCount > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-[58px]">
            {allRecipients.map((addr, i) => (
              <span key={`${addr}-${i}`} className="recipient-chip">
                <span className="rc-av">{chipInitials(addr)}</span>
                <span className="break-all">{addr}</span>
              </span>
            ))}
          </div>
        )}

        {attachments > 0 && (
          <div className="pl-[58px] text-meta font-mono text-ink-fg-2">
            {t('compose.sendConfirm.attachments', { n: attachments })}
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            className="gbtn gbtn-bare"
            onClick={onCancel}
            disabled={pending}
          >
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

interface DiscardProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DiscardDialog({ open, onConfirm, onCancel }: DiscardProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[11px] grid place-items-center shrink-0',
                'text-fail bg-fail/10 border border-fail/30'
              )}
            >
              <Trash2 size={20} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('compose.discardConfirm.title')}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">
                {t('compose.discardConfirm.body')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel}>
            {t('compose.cancel')}
          </button>
          <button type="button" className="gbtn gbtn-danger-solid" onClick={onConfirm}>
            <Trash2 size={13} strokeWidth={2} />
            {t('compose.discardConfirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
