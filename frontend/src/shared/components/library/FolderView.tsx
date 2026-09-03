// 文件夹视图（design §2.3；mockup B1–B3、C13 废纸篓）：网格 / 列表双视图 + 服务端排序 + 服务端过滤
// + 投影区说明条 + 空态 + 拖入复制入库 + 行菜单。
//
// 🔴 过滤与排序都发给服务端：分页 200 之后，客户端只能排 / 筛当前这一页（第 2 页起就是错的）。
// 投影区的 `q` 在服务端同时匹配文件名与来源列（主题 / 发件人，F4）；投影文件夹忽略 sort
// （固定按邮件日期倒序），排序控件在那儿置灰。

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, RotateCcw, Search, Trash2 } from 'lucide-react'

import type { LibraryFolderSort } from '@shared/api/library'
import type { LibraryFile } from '@shared/api/types/library'
import { Button } from '@shared/components/ui/button'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { formatFileSize } from '@shared/format'
import { useDebouncedValue } from '@shared/hooks/useDebouncedValue'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useLibraryTree } from '@shared/state/library-tree'

import { displayName, fileTimeLabel, isProjection, libraryIconTone, trashDaysLeft } from './fileMeta'
import { useLibraryFolderPages } from './hooks'
import { FileStatusPill, Notice, Pill, SourcePill, TextStatusPill } from './parts'
import type { LibraryFileActions } from './useLibraryFileActions'

const SORT_KEYS: readonly LibraryFolderSort[] = ['name', 'size', 'type', 'date']
const SORT_LABEL_KEY: Record<LibraryFolderSort, string> = {
  name: 'library.folder.sortName',
  size: 'library.folder.sortSize',
  type: 'library.folder.sortType',
  date: 'library.folder.sortDate'
}
const FILTER_DEBOUNCE_MS = 250

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function KindLabel({ file }: { file: Pick<LibraryFile, 'kind'> }): ReactElement {
  const { t } = useTranslation()
  return <>{t(`library.common.kind.${file.kind}`)}</>
}

function creatorLabel(file: Pick<LibraryFile, 'created_by'>, t: (k: string) => string): string {
  if (file.created_by === 'user') return t('library.common.sourceLabel.user')
  return file.created_by ?? '—'
}

/* ── 网格磁贴（照 AttachmentList 的配方重排：2 列 / 9×9 色调方块 / 名 + 大小两行） ─────── */

function Tile({
  file,
  onOpen,
  onMenu
}: {
  file: LibraryFile
  onOpen(): void
  onMenu(el: HTMLButtonElement): void
}): ReactElement {
  const { t } = useTranslation()
  const tone = libraryIconTone(file)
  const I = tone.Icon
  return (
    <div
      className={cn(
        'group/tile relative flex items-start gap-3 rounded-md border border-ink-border bg-ink-2 px-3 py-2.5',
        file.status !== 'present' && 'opacity-65'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn('grid size-9 shrink-0 place-items-center rounded-md border', tone.bg, tone.border)}
        aria-label={t('library.folder.openAria', { name: file.filename })}
      >
        <I size={16} strokeWidth={2} className={tone.text} />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 self-center text-left">
        <div className="truncate text-aux font-medium text-ink-fg">{displayName(file)}</div>
        <div className="font-mono text-meta tabular-nums text-ink-fg-2">
          {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'}
          <span className="mx-1 text-ink-fg-3">·</span>
          <KindLabel file={file} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <SourcePill file={file} />
          <TextStatusPill file={file} />
          <FileStatusPill file={file} />
        </div>
      </button>
      <button
        type="button"
        aria-label={t('library.folder.moreAria')}
        onClick={(e) => onMenu(e.currentTarget)}
        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-ink-fg focus-visible:opacity-100 group-hover/tile:opacity-100"
      >
        <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}

/* ── 列表行 ────────────────────────────────────────────────────── */

function columns(projection: boolean): string {
  return projection
    ? '20px minmax(0,2.2fr) 78px 124px 74px minmax(0,1.6fr) 88px 28px'
    : '20px minmax(0,2.6fr) 78px 124px 74px minmax(0,1.2fr) 88px 28px'
}

function Row({
  file,
  projection,
  onOpen,
  onMenu
}: {
  file: LibraryFile
  projection: boolean
  onOpen(): void
  onMenu(el: HTMLButtonElement): void
}): ReactElement {
  const { t } = useTranslation()
  const tone = libraryIconTone(file)
  const I = tone.Icon
  const sourceText = projection
    ? (file.source_label ?? '')
    : t(`library.common.sourceLabel.${file.source}`)
  return (
    <div
      className={cn(
        'group/row grid items-center gap-3 border-b border-ink-border-soft px-3 py-1.5 text-aux',
        'hover:bg-ink-3/60',
        file.status !== 'present' && 'opacity-60'
      )}
      style={{ gridTemplateColumns: columns(projection) }}
    >
      <span className={cn('grid size-5 place-items-center rounded', tone.bg)}>
        <I size={12} strokeWidth={2} className={tone.text} />
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <span className="block truncate text-ink-fg">{displayName(file)}</span>
        {displayName(file) !== file.filename ? (
          <span className="block truncate font-mono text-micro text-ink-fg-3">{file.filename}</span>
        ) : null}
      </button>
      <span className="font-mono text-meta tabular-nums text-ink-fg-2">
        {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'}
      </span>
      <span className="font-mono text-meta tabular-nums text-ink-fg-2">{fileTimeLabel(file)}</span>
      <span className="text-meta text-ink-fg-2">
        <KindLabel file={file} />
      </span>
      <span className="min-w-0 truncate text-meta text-ink-fg-2" title={sourceText}>
        {sourceText}
      </span>
      <span className="truncate text-meta text-ink-fg-2">{creatorLabel(file, t)}</span>
      <button
        type="button"
        aria-label={t('library.folder.moreAria')}
        onClick={(e) => onMenu(e.currentTarget)}
        className="grid size-6 place-items-center rounded text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-ink-fg focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}

function ListHeader({ projection }: { projection: boolean }): ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className="grid items-center gap-3 border-b border-ink-border px-3 py-1.5 font-mono text-micro uppercase tracking-widest text-ink-fg-3"
      style={{ gridTemplateColumns: columns(projection) }}
    >
      <span />
      <span>{t('library.folder.colName')}</span>
      <span>{t('library.folder.colSize')}</span>
      <span>{t('library.folder.colMtime')}</span>
      <span>{t('library.folder.colKind')}</span>
      <span>{t('library.folder.colSource')}</span>
      <span>{t('library.folder.colCreator')}</span>
      <span />
    </div>
  )
}

/* ── 废纸篓行（C13）：原位置 + 剩余天数 + 恢复 / 立即永久删除 ──────────── */

function TrashRow({
  file,
  actions
}: {
  file: LibraryFile
  actions: LibraryFileActions
}): ReactElement {
  const { t } = useTranslation()
  const days = trashDaysLeft(file)
  return (
    <div className="flex items-center gap-3 border-b border-ink-border-soft px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-aux text-ink-fg">{file.filename}</div>
        <div className="truncate font-mono text-micro text-ink-fg-3">
          {t('library.trash.originalLocation', { path: file.path })}
        </div>
      </div>
      <Pill tone={days <= 5 ? 'warn' : 'ink'}>{t('library.trash.fileTrashedHint', { days })}</Pill>
      <Button size="sm" variant="secondary" onClick={() => actions.restore(file)}>
        <RotateCcw size={13} aria-hidden />
        {t('library.trash.restoreAction')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-fail hover:bg-fail/10 hover:text-fail"
        onClick={() => actions.purge(file)}
      >
        <Trash2 size={13} aria-hidden />
        {t('library.trash.deleteForeverAction')}
      </Button>
    </div>
  )
}

/* ── 主体 ──────────────────────────────────────────────────────── */

export interface FolderViewProps {
  path: string
  /** 投影根 / ro 挂载 / 不可用挂载 / 废纸篓：没有拖入、没有写动作。 */
  readonly: boolean
  trash: boolean
  actions: LibraryFileActions
  onOpenFile(file: LibraryFile): void
  onDropFiles(files: File[]): void
}

export function FolderView({
  path,
  readonly,
  trash,
  actions,
  onOpenFile,
  onDropFiles
}: FolderViewProps): ReactElement {
  const { t } = useTranslation()
  const projection = isProjection({ path })
  const view = useLibraryTree((s) => s.view)
  const sortKey = useLibraryTree((s) => s.sortKey)
  const sortDir = useLibraryTree((s) => s.sortDir)
  const setView = useLibraryTree((s) => s.setView)
  const setSort = useLibraryTree((s) => s.setSort)

  const [filter, setFilter] = useState('')
  const debouncedFilter = useDebouncedValue(filter, FILTER_DEBOUNCE_MS)
  // 换文件夹清过滤词（过滤是「这一个文件夹」的，design §2.3 B3）。
  const lastPath = useRef(path)
  if (lastPath.current !== path) {
    lastPath.current = path
    setFilter('')
  }

  const pages = useLibraryFolderPages(path, { q: debouncedFilter, sort: sortKey, dir: sortDir })
  const files = useMemo(() => (pages.data?.pages ?? []).flatMap((p) => p.files), [pages.data])
  const total = pages.data?.pages[0]?.total ?? 0

  const [sortOpen, setSortOpen] = useState(false)
  const sortTrigger = useRef<HTMLButtonElement | null>(null)
  const [menuFile, setMenuFile] = useState<LibraryFile | null>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    dragDepth.current = 0
  }, [path])

  const sortItems = useMemo(
    (): readonly PopmenuItem[] =>
      SORT_KEYS.map((key) => ({
        kind: 'radio',
        id: key,
        label: t(SORT_LABEL_KEY[key]),
        checked: sortKey === key,
        closeOnSelect: true,
        onSelect: () => setSort(key)
      })),
    [setSort, sortKey, t]
  )

  const fileMenuItems = useMemo((): readonly PopmenuItem[] => {
    const file = menuFile
    if (file === null) return []
    const items: PopmenuItem[] = [
      { kind: 'action', id: 'open', label: t('library.folder.menuOpen'), onSelect: () => onOpenFile(file) },
      {
        kind: 'action',
        id: 'system',
        label: t('library.actions.openSystem'),
        disabled: file.status !== 'present',
        onSelect: () => actions.open(file)
      },
      {
        kind: 'action',
        id: 'reveal',
        label: t('library.actions.reveal'),
        disabled: file.status !== 'present',
        onSelect: () => actions.reveal(file)
      }
    ]
    if (isProjection(file)) {
      items.push({ kind: 'separator', id: 's1' })
      items.push({
        kind: 'action',
        id: 'keep',
        label: t('library.actions.keepToLibrary'),
        disabled: file.status !== 'present',
        onSelect: () => actions.keep(file)
      })
    } else if (!readonly) {
      items.push({ kind: 'separator', id: 's1' })
      items.push({
        kind: 'action',
        id: 'move',
        label: t('library.actions.moveTo'),
        onSelect: () => actions.move(file)
      })
      items.push({
        kind: 'action',
        id: 'del',
        label: t('library.actions.delete'),
        tone: 'danger',
        onSelect: () => actions.trash(file)
      })
    }
    return items
  }, [actions, menuFile, onOpenFile, readonly, t])

  const openMenu = (file: LibraryFile, el: HTMLButtonElement): void => {
    menuTrigger.current = el
    setMenuFile(file)
  }

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (readonly || !hasFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (readonly || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (): void => {
    if (readonly) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (readonly || !hasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const dropped = Array.from(event.dataTransfer.files)
    if (dropped.length > 0) onDropFiles(dropped)
  }

  const folderName = path.split('/').pop() ?? path
  const sortLocked = projection || trash
  const empty = !pages.isPending && files.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-border-soft px-4 py-2">
        {/* 文件夹级过滤：窄框贴工具条，与全库搜索（页头宽框 + 结果分组）形态刻意不同。 */}
        <label className="flex h-7 w-[220px] items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2">
          <Search size={12} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('library.folder.filterPlaceholder')}
            aria-label={t('library.folder.filterPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-meta text-ink-fg outline-none placeholder:text-ink-fg-3"
          />
        </label>
        <div className="relative">
          <button
            ref={sortTrigger}
            type="button"
            disabled={sortLocked}
            title={sortLocked ? t('library.folder.sortDisabledHint') : undefined}
            onClick={() => setSortOpen((v) => !v)}
            className="h-7 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t(SORT_LABEL_KEY[sortKey])}
          </button>
          <Popmenu
            open={sortOpen}
            onClose={() => setSortOpen(false)}
            ariaLabel={t('library.folder.sortAria')}
            triggerRef={sortTrigger}
            align="start"
            width={200}
            items={sortItems}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            value={view}
            onChange={setView}
            ariaLabel={t('library.folder.viewAria')}
            options={[
              { value: 'grid', label: t('library.folder.viewGrid') },
              { value: 'list', label: t('library.folder.viewList') }
            ]}
          />
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-dragging={dragging ? 'true' : undefined}
      >
        {projection ? (
          <div className="sticky top-0 z-10 border-b border-ink-border-soft bg-ink-1/95 px-4 py-1.5 text-meta text-ink-fg-2">
            {t('library.tree.projectionNotice')}
          </div>
        ) : null}
        {trash ? (
          <div className="border-b border-ink-border-soft px-4 py-1.5 text-meta text-ink-fg-2">
            {t('library.trash.notice')}
          </div>
        ) : null}

        {pages.isPending ? (
          <Skeleton rows={6} className="p-4" width="2/3" />
        ) : pages.isError ? (
          <div className="p-4">
            <Notice tone="fail">
              {t('library.folder.loadFailed')}
              <span className="ml-1.5 text-ink-fg-3">{errorMessage(pages.error)}</span>
            </Notice>
          </div>
        ) : empty ? (
          <div className="grid place-items-center gap-1 px-6 py-16 text-center">
            <div className="text-aux text-ink-fg-1">{t('library.empty.folderTitle')}</div>
            <div className="text-meta text-ink-fg-3">{t('library.empty.folderHint')}</div>
          </div>
        ) : trash ? (
          <div>
            {files.map((file) => (
              <TrashRow key={file.id ?? file.path} file={file} actions={actions} />
            ))}
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 gap-2 p-3">
            {files.map((file) => (
              <Tile
                key={file.id ?? `a:${file.attachment_id}`}
                file={file}
                onOpen={() => onOpenFile(file)}
                onMenu={(el) => openMenu(file, el)}
              />
            ))}
          </div>
        ) : (
          <div>
            <ListHeader projection={projection} />
            {files.map((file) => (
              <Row
                key={file.id ?? `a:${file.attachment_id}`}
                file={file}
                projection={projection}
                onOpen={() => onOpenFile(file)}
                onMenu={(el) => openMenu(file, el)}
              />
            ))}
          </div>
        )}

        {pages.hasNextPage ? (
          <div className="flex justify-center px-4 py-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {t('library.folder.loadMore', { shown: files.length, total })}
            </Button>
          </div>
        ) : null}

        {dragging ? (
          <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-[var(--r-card)] border-2 border-dashed border-coral/70 bg-coral/[0.08]">
            <span className="rounded-full bg-ink-0/85 px-3 py-1.5 text-aux font-medium text-ink-fg">
              {t('library.folder.dropTarget', { folder: folderName })}
            </span>
          </div>
        ) : null}

        {menuFile ? (
          <Popmenu
            open
            onClose={() => setMenuFile(null)}
            ariaLabel={t('library.folder.fileMenuAria', { name: menuFile.filename })}
            title={menuFile.filename}
            portal
            align="end"
            width={252}
            triggerRef={menuTrigger}
            items={fileMenuItems}
          />
        ) : null}
      </div>
    </div>
  )
}
