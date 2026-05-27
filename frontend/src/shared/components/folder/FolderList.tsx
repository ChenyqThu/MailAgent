// Phase C — 存档 / 草稿箱列表栏. 精简版 EmailList: 无 thread 折叠 / AI 分桶 /
// filter / 分页 (folder 体量小, 一次拉 200 封够用). react-query useQuery
// (['folder', folder]) + usePollingFallback SSE 断线兜底 (仿 EmailList)。
//
// 草稿列表顶部多一个「+ 新建草稿」按钮 → 调 onNewDraft 打开空 DraftEditor。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Loader2, Mail, Plus, RefreshCw } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import type { FolderName } from '@shared/api/types'

import { FolderRow } from './FolderRow'

interface Props {
  folder: FolderName
  activeId: number | null
  onSelect(id: number): void
  /** drafts 模式专属 — 顶部「+ 新建草稿」按钮回调 (打开空 editor). */
  onNewDraft?: () => void
  /** 顶部「同步」按钮 — pending 状态由父级 mutation 控制. */
  onSync?: () => void
  syncing?: boolean
}

const LIST_LIMIT = 200

export function FolderList({
  folder,
  activeId,
  onSelect,
  onNewDraft,
  onSync,
  syncing
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const pollingInterval = usePollingFallback()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['folder', folder],
    queryFn: () => mailApi.folder.list({ folder, limit: LIST_LIMIT }),
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData
  })

  const rows = useMemo(() => data ?? [], [data])
  const isDrafts = folder === 'drafts'

  return (
    <section
      aria-label={isDrafts ? 'drafts-list' : 'archive-list'}
      className="w-[340px] shrink-0 glass-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header — title + sync; drafts 多一个 新建草稿 按钮 */}
      <div className="px-3 pt-3 pb-2.5 border-b border-ink-border-soft">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-body font-medium text-ink-fg">
            {isDrafts ? t('folder.draftsTitle') : t('folder.archiveTitle')}
          </h1>
          <div className="flex items-center gap-1">
            {onSync && (
              <button
                type="button"
                className="w-7 h-7 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
                title={syncing ? t('folder.syncing') : t('folder.sync')}
                aria-label={syncing ? t('folder.syncing') : t('folder.sync')}
                onClick={onSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} strokeWidth={2} />
                )}
              </button>
            )}
          </div>
        </div>

        {isDrafts && onNewDraft && (
          <button
            type="button"
            onClick={onNewDraft}
            className={cn(
              'mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md',
              'text-aux font-medium btn-cta transition-colors duration-fast'
            )}
          >
            <Plus size={13} strokeWidth={2.5} />
            {t('folder.newDraft')}
          </button>
        )}

        <div className="mt-2 text-meta font-mono text-ink-fg-2 tabular-nums">{rows.length}</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {isLoading && (
          <div className="p-6 text-aux text-ink-fg-2 animate-pulse">{t('folder.loading')}</div>
        )}
        {isError && (
          <div className="p-6 text-aux text-fail">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="px-6 py-12 text-center text-aux text-ink-fg-2">
            <Mail size={20} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
            <div>{isDrafts ? t('folder.emptyDrafts') : t('folder.emptyArchive')}</div>
          </div>
        )}
        {!isLoading &&
          !isError &&
          rows.map((row) => (
            <FolderRow
              key={row.id}
              email={row}
              selected={row.id === activeId}
              onSelect={() => onSelect(row.id)}
            />
          ))}
      </div>
    </section>
  )
}
