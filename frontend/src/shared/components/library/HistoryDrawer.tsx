// 历史抽屉（design §4；mockup C9）—— P1 只读列表：时间 / 改动者 / 快照字节数 / 变更说明。
// 查看快照与回滚是 P2（列表端点不带快照正文，见 `LibraryHistoryEntry` 头注）。
// `changed_by='external'` 的行天生没有 change_note：那是「打开时对账补记」的外部改动，
// 占位文案要把这件事说出来（mockup F8）。

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock3, X } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { Drawer } from '@shared/components/ui/drawer'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { formatFileSize } from '@shared/format'
import { errorMessage } from '@shared/lib/ipcErrors'

import { formatShortTime } from './fileMeta'
import { useLibraryHistoryQuery } from './hooks'
import { Notice, Pill } from './parts'

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  file: LibraryFile
}

export function HistoryDrawer({ open, onOpenChange, file }: Props): ReactElement {
  const { t } = useTranslation()
  const history = useLibraryHistoryQuery(file.id, open)

  const changedByLabel = (who: string): string => {
    if (who === 'user') return t('library.history.changedByUser')
    if (who === 'external') return t('library.history.changedByExternal')
    return who
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} ariaLabel={t('library.actions.history')} width={560}>
      <div className="flex h-full flex-col bg-ink-1">
        <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-ink-border px-4">
          <Clock3 size={14} strokeWidth={1.9} aria-hidden className="text-ink-fg-2" />
          <span className="flex-1 truncate text-body font-medium text-ink-fg">
            {t('library.actions.history')} · {file.filename}
          </span>
          <button
            type="button"
            aria-label={t('library.actions.close')}
            onClick={() => onOpenChange(false)}
            className="grid size-7 place-items-center rounded text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="px-4 py-2 text-meta text-ink-fg-3">{t('library.history.retention')}</div>
          {history.isPending ? (
            <Skeleton rows={5} className="px-4 py-2" width="2/3" />
          ) : history.isError ? (
            <div className="px-4 py-2">
              <Notice tone="fail">
                {t('library.history.loadFailed')}
                <span className="ml-1.5 text-ink-fg-3">{errorMessage(history.error)}</span>
              </Notice>
            </div>
          ) : history.data.length === 0 ? (
            <div className="px-4 py-3 text-meta text-ink-fg-3">{t('library.history.empty')}</div>
          ) : (
            history.data.map((entry) => (
              <div key={entry.id} className="border-b border-ink-border-soft px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-meta tabular-nums text-ink-fg-2">
                    {formatShortTime(entry.created_at)}
                  </span>
                  <Pill
                    tone={
                      entry.changed_by === 'user'
                        ? 'ink'
                        : entry.changed_by === 'external'
                          ? 'warn'
                          : 'ai'
                    }
                  >
                    {changedByLabel(entry.changed_by)}
                  </Pill>
                  <span className="font-mono text-micro tabular-nums text-ink-fg-3">
                    {formatFileSize(entry.snapshot_bytes)}
                  </span>
                </div>
                <div className="mt-0.5 text-meta text-ink-fg-1">
                  {entry.change_note ?? (
                    <span className="text-ink-fg-3">
                      {entry.changed_by === 'external'
                        ? t('library.history.externalNoNote')
                        : t('library.history.noNote')}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Drawer>
  )
}
