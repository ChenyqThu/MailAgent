import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { MATTER_ITEM_KINDS } from '@shared/api/types/matter'
import type { MatterItemCreateInput, MatterItemKind } from '@shared/api/types/matter'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'

interface AddItemModalProps {
  open: boolean
  initialKind?: MatterItemKind
  busy?: boolean
  onClose(): void
  onAdd(input: MatterItemCreateInput): void
}

export function AddItemModal({
  open,
  initialKind = 'action',
  busy = false,
  onClose,
  onAdd
}: AddItemModalProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [kind, setKind] = useState<MatterItemKind>(initialKind)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-add-item-title"
        className="w-full max-w-lg rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
      >
        <header className="flex items-center justify-between border-b border-ink-border px-5 py-4">
          <h2 id="matter-add-item-title" className="text-lead font-semibold">
            {t('matters.item.addTitle')}
          </h2>
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.item.kind')}</span>
            <Select value={kind} onValueChange={(value) => setKind(value as MatterItemKind)}>
              <SelectTrigger aria-label={t('matters.item.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATTER_ITEM_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`matters.item.kinds.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.item.name')}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.item.description')}</span>
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-ink-border px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] px-3 py-2 text-body hover:bg-ink-3">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!title.trim() || busy}
            onClick={() => onAdd({ kind, title: title.trim(), description: description || null })}
            className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-body font-medium text-accent-fg disabled:opacity-50"
          >
            {t('matters.item.add')}
          </button>
        </footer>
      </section>
    </div>
  )
}
