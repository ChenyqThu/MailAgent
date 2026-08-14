// 首次 backfill 进度条（设计 §2.1 / §2.8）：后台自动扫描，列表全程可交互；
// 提示条可关，关了不影响扫描（只是本 session 不再显示）。

import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ContactBackfillProgress } from '@shared/api/types/contact'

export function BackfillBar({
  progress
}: {
  progress: ContactBackfillProgress | undefined
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  if (!progress || progress.drained || dismissed || progress.total === 0) return null
  const ratio = Math.min(1, progress.scanned / Math.max(1, progress.total))
  return (
    <div className="mx-3 mb-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-2">
          {t('contacts.backfill.progress', {
            scanned: progress.scanned,
            total: progress.total
          })}
        </span>
        <button
          type="button"
          aria-label={t('contacts.backfill.dismiss')}
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-[var(--r-ctl)] p-0.5 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-1"
        >
          <X size={12} />
        </button>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-ink-3">
        <div
          className="h-full rounded-full bg-coral/70 transition-[width] duration-500"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  )
}
