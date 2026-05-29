// Phase C — 存档 / 草稿箱列表栏. Sprint 18 视觉重写 → ref/mockup-archive.html
// + mockup-drafts.html。精简版 EmailList: 无 thread 折叠 / AI 分桶 / filter /
// 分页 (folder 体量小, 一次拉 200 封)。react-query useQuery(['folder', folder])
// + usePollingFallback SSE 断线兜底。
//
// header: 标题 + 计数 + 同步; 草稿多一个满宽 primary「新建草稿」按钮。
// 4 状态层 — data / loading(骨架屏 shimmer) / empty(图标块 + CTA) /
//   error(fail 图标 + 重试)。空态绝不显示裸 "0"。
// footer: 排序说明 + 已保存状态点。
// 行 hover 浮动删除 → onRequestDelete(id) 上抛 (FolderLayout 统一确认)。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { AlertTriangle, Archive, FileEdit, Loader2, Plus, RefreshCw } from 'lucide-react'

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
  /** 行 hover 浮动删除 — 父级统一弹确认 + 复用 deleteMsg mutation. */
  onRequestDelete?: (id: number) => void
}

const LIST_LIMIT = 200

// ── 骨架屏一行 (mockup loading 态). ──────────────────────────────────────
function SkeletonRow({ widths }: { widths: [string, string, string] }): React.ReactElement {
  return (
    <div className="grid grid-cols-[34px_1fr] gap-3">
      <div className="folder-skel w-[34px] h-[34px] rounded-full" />
      <div className="space-y-2 pt-0.5">
        <div className={cn('folder-skel h-3', widths[0])} />
        <div className={cn('folder-skel h-3', widths[1])} />
        <div className={cn('folder-skel h-2.5', widths[2])} />
      </div>
    </div>
  )
}

export function FolderList({
  folder,
  activeId,
  onSelect,
  onNewDraft,
  onSync,
  syncing,
  onRequestDelete
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const pollingInterval = usePollingFallback()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['folder', folder],
    queryFn: () => mailApi.folder.list({ folder, limit: LIST_LIMIT }),
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    // 切到 收件箱/设置/日历 再切回 存档/草稿箱不重拉 + 不闪 loading: folder_email
    // 已是本地 SSoT (FolderSyncWorker 增量同步 + body 落库), 后端同步完成会发
    // folder.synced 事件经 SSE invalidate ['folder'] (useEventBridge), 所以缓存
    // 可放心拉长——5min 内无变化切回直接命中, gcTime 15min 防卸载后过早回收。
    // 与收件箱 EmailList 的缓存策略对齐 (Bug#3 同款修复)。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: keepPreviousData
  })

  const rows = useMemo(() => data ?? [], [data])
  const isDrafts = folder === 'drafts'
  const hasRows = !isLoading && !isError && rows.length > 0
  const isEmpty = !isLoading && !isError && rows.length === 0
  const EmptyIcon = isDrafts ? FileEdit : Archive

  return (
    <section
      aria-label={isDrafts ? 'drafts-list' : 'archive-list'}
      className="w-[340px] shrink-0 glass-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header — title + count + sync; drafts 多一个满宽「新建草稿」 */}
      <div className="px-4 pt-3.5 pb-3 border-b border-ink-border-soft shrink-0">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-lead font-semibold text-ink-fg truncate">
              {isDrafts ? t('folder.draftsTitle') : t('folder.archiveTitle')}
            </h1>
            {hasRows && (
              <span className="text-meta font-mono text-ink-fg-2 tabular-nums shrink-0">
                {t('folder.count', { count: rows.length })}
              </span>
            )}
          </div>
          {onSync && (
            <button
              type="button"
              className="w-7 h-7 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title={syncing ? t('folder.syncing') : t('folder.sync')}
              aria-label={syncing ? t('folder.syncing') : t('folder.sync')}
              onClick={onSync}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <RefreshCw size={14} strokeWidth={2} />
              )}
            </button>
          )}
        </div>

        {isDrafts && onNewDraft && (
          <button
            type="button"
            onClick={onNewDraft}
            className="gbtn gbtn-primary w-full justify-center"
            style={{ height: '34px' }}
          >
            <Plus size={14} strokeWidth={2.2} />
            {t('folder.newDraft')}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin relative">
        {/* loading — shimmer skeleton rows */}
        {isLoading && (
          <div className="p-4 space-y-5">
            <div className="flex items-center gap-2 text-meta font-mono text-ink-fg-2 pb-1">
              <Loader2 size={13} strokeWidth={2.5} className="animate-spin text-coral" />
              {isDrafts ? t('folder.skeletonDrafts') : t('folder.skeletonArchive')}
            </div>
            <SkeletonRow widths={['w-3/4', 'w-1/2', 'w-full']} />
            <SkeletonRow widths={['w-2/3', 'w-3/5', 'w-5/6']} />
            <SkeletonRow widths={['w-4/5', 'w-2/5', 'w-full']} />
            <SkeletonRow widths={['w-3/5', 'w-1/2', 'w-4/5']} />
          </div>
        )}

        {/* error — fail icon + retry */}
        {isError && (
          <div className="h-full flex flex-col items-center justify-center text-center px-8 py-12">
            <div className="w-16 h-16 rounded-2xl grid place-items-center mb-4 bg-fail/10 border border-fail/25">
              <AlertTriangle size={26} strokeWidth={1.6} className="text-fail" />
            </div>
            <div className="text-aux text-ink-fg font-medium mb-1.5">
              {isDrafts ? t('folder.errorTitleDrafts') : t('folder.errorTitleArchive')}
            </div>
            <p className="text-meta text-ink-fg-2 leading-relaxed max-w-[230px] mb-4">
              {isDrafts ? t('folder.errorBodyDrafts') : t('folder.errorBodyArchive')}
            </p>
            <p className="text-micro font-mono text-ink-fg-3 max-w-[230px] mb-3 truncate">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <button type="button" className="gbtn gbtn-primary" onClick={() => void refetch()}>
              <RefreshCw size={13} strokeWidth={2} />
              {t('folder.retry')}
            </button>
          </div>
        )}

        {/* empty — icon block + CTA */}
        {isEmpty && (
          <div className="h-full flex flex-col items-center justify-center text-center px-8 py-12">
            <div className="w-16 h-16 rounded-2xl grid place-items-center mb-4 bg-ink-3/60 border border-ink-border-soft">
              <EmptyIcon size={28} strokeWidth={1.5} className="text-ink-fg-3" />
            </div>
            <div className="text-aux text-ink-fg font-medium mb-1.5">
              {isDrafts ? t('folder.emptyDraftsTitle') : t('folder.emptyArchiveTitle')}
            </div>
            <p className="text-meta text-ink-fg-2 leading-relaxed max-w-[220px] mb-4">
              {isDrafts ? t('folder.emptyDraftsBody') : t('folder.emptyArchiveBody')}
            </p>
            {isDrafts && onNewDraft && (
              <button type="button" className="gbtn gbtn-primary" onClick={onNewDraft}>
                <Plus size={13} strokeWidth={2.2} />
                {t('folder.emptyDraftsCta')}
              </button>
            )}
          </div>
        )}

        {/* data */}
        {hasRows &&
          rows.map((row) => (
            <FolderRow
              key={row.id}
              email={row}
              selected={row.id === activeId}
              onSelect={() => onSelect(row.id)}
              onRequestDelete={onRequestDelete ? () => onRequestDelete(row.id) : undefined}
            />
          ))}
      </div>

      {/* footer — sort hint + saved/synced status dot */}
      <div className="px-4 py-2 border-t border-ink-border-soft shrink-0 text-micro font-mono text-ink-fg-3 flex items-center justify-between gap-2">
        <span className="truncate">
          {isDrafts ? t('folder.footerDrafts') : t('folder.footerArchive')}
        </span>
        {hasRows && (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
            {isDrafts ? t('folder.footerSavedDrafts') : t('folder.footerSyncedArchive')}
          </span>
        )}
      </div>
    </section>
  )
}
