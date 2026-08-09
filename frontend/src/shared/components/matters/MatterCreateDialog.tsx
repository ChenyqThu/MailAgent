import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { BUILTIN_MATTER_TYPES, MATTER_PRIORITIES } from '@shared/api/types/matter'
import type { MatterCreateInput, MatterPriority } from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'

interface MatterCreateDialogProps {
  open: boolean
  busy?: boolean
  onClose(): void
  onCreate(input: MatterCreateInput): void
}

export function MatterCreateDialog({
  open,
  busy = false,
  onClose,
  onCreate
}: MatterCreateDialogProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [matterType, setMatterType] = useState('')
  const [priority, setPriority] = useState<MatterPriority>('p1')
  const [description, setDescription] = useState('')

  if (!open) return null

  const submit = (): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    onCreate({
      title: trimmedTitle,
      matter_type: matterType.trim() || null,
      priority,
      description
    })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-create-title"
        className="w-full max-w-xl rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
      >
        <header className="flex items-center justify-between border-b border-ink-border px-5 py-4">
          <h2 id="matter-create-title" className="text-title font-semibold text-ink-fg">
            {t('matters.create.title')}
          </h2>
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.name')}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.type')}</span>
            <input
              list="matter-types"
              value={matterType}
              onChange={(event) => setMatterType(event.target.value)}
              placeholder={t('matters.create.typePlaceholder')}
              className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
            <datalist id="matter-types">
              {BUILTIN_MATTER_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>
          <div className="space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.priority')}</span>
            <SegmentedControl<MatterPriority>
              value={priority}
              onChange={setPriority}
              options={MATTER_PRIORITIES.map((value) => ({ value, label: value.toUpperCase() }))}
              ariaLabel={t('matters.create.priority')}
            />
          </div>
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.description')}</span>
            <textarea
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
            <span className="text-meta text-ink-fg-2">{t('matters.create.descriptionHint')}</span>
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-ink-border px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] px-3 py-2 text-body hover:bg-ink-3">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!title.trim() || busy}
            onClick={submit}
            className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-body font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? t('matters.create.creating') : t('matters.create.submit')}
          </button>
        </footer>
      </section>
    </div>
  )
}
