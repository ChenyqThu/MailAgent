// 首次 backfill 进度条（设计 §2.1 / §2.8 · 原型 `clist.jsx::BackfillBar`）：后台
// 自动扫描，列表全程可交互；提示条可关，关了不影响扫描（只是本 session 不再显示）。
// 形态 = 通栏 info 调条（不是浮在列表上的卡片）：文案 + 细进度条 + 百分比 + 关闭。

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
  const percent = Math.round(ratio * 100)
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-info/25 bg-info/[0.07] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-meta text-ink-fg-1">
          {t('contacts.backfill.progress', {
            scanned: progress.scanned,
            total: progress.total
          })}
        </div>
        <div className="mt-[5px] h-[3px] overflow-hidden rounded-full bg-ink-fg/10">
          <div
            className="h-full rounded-full bg-info transition-[width] duration-slow ease-standard"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-2">{percent}%</span>
      <button
        type="button"
        aria-label={t('contacts.backfill.dismiss')}
        onClick={() => setDismissed(true)}
        className="grid size-[22px] shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg-1"
      >
        <X size={12} />
      </button>
    </div>
  )
}
