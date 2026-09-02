// 文件夹视图（design §2.3）：网格 / 列表双视图 + 排序 + 来源列 + 空态 + 拖入覆盖层。
//
// 复用的真东西：
//   · `ui/segmented` 的 SegmentedControl（视图切换）
//   · `email/attachmentPreview.pickIconTone`（磁贴与行的图标色调，经 parts/fileMeta）
//   · `format.formatFileSize`
//   · `AttachmentList` 的磁贴配方（2 列 grid / 9×9 色调方块 / 名 + 大小两行）——
//     那是组件内联的 JSX，不是可 import 的件，所以这里按它的类名逐字重排。

import * as React from 'react'
import { Loader2, MoreHorizontal, Search } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'

import type { LibFile } from '../fixtures'
import { S } from '../strings'
import { creatorLabel, displayName, KIND_LABEL, sourceLabel, toneOf } from './fileMeta'
import { Pill } from './kit'

export type ViewMode = 'grid' | 'list'
export type SortKey = 'name' | 'size' | 'type' | 'date'

function shortTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function sortFiles(files: LibFile[], key: SortKey): LibFile[] {
  const out = [...files]
  out.sort((a, b) => {
    switch (key) {
      case 'size':
        return (b.size_bytes ?? 0) - (a.size_bytes ?? 0)
      case 'type':
        return a.kind.localeCompare(b.kind) || a.filename.localeCompare(b.filename, 'zh-CN')
      case 'date':
        return new Date(b.mtime).getTime() - new Date(a.mtime).getTime()
      default:
        return displayName(a).localeCompare(displayName(b), 'zh-CN')
    }
  })
  return out
}

/** text_status 的小徽标（列表 / 磁贴 / 预览头三处同款）。 */
export function TextStatusPill({ file }: { file: LibFile }): React.ReactElement | null {
  switch (file.text_status) {
    case 'pending':
      return <Pill tone="info">{S.textStatus.pending}</Pill>
    case 'failed':
      return <Pill tone="fail">{S.textStatus.failed}</Pill>
    case 'unsupported':
      return <Pill tone="ink">{S.textStatus.unsupported}</Pill>
    default:
      return null
  }
}

function StatusPill({ file }: { file: LibFile }): React.ReactElement | null {
  if (file.status === 'missing') {
    return (
      <Pill tone="warn" title={S.fileStatus.missingHint}>
        {S.fileStatus.missing}
      </Pill>
    )
  }
  if (file.status === 'trashed') {
    return (
      <Pill tone="ink" title={S.fileStatus.trashedHint(file.trashDaysLeft ?? 30)}>
        {S.fileStatus.trashed}
      </Pill>
    )
  }
  return null
}

/* ── 工具条 ─────────────────────────────────────────────────────── */

export function FolderToolbar({
  view,
  onView,
  sort,
  onSort,
  filter,
  onFilter,
  right
}: {
  view: ViewMode
  onView(v: ViewMode): void
  sort: SortKey
  onSort(s: SortKey): void
  filter: string
  onFilter(v: string): void
  right?: React.ReactNode
}): React.ReactElement {
  const [sortOpen, setSortOpen] = React.useState(false)
  const sortRef = React.useRef<HTMLButtonElement | null>(null)
  const sortItems: PopmenuItem[] = (['name', 'size', 'type', 'date'] as const).map((k) => ({
    kind: 'radio',
    id: k,
    label: S.sort[k],
    checked: sort === k,
    closeOnSelect: true,
    onSelect: () => onSort(k)
  }))

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink-border-soft px-4 py-2">
      {/* 文件夹级过滤：贴在文件夹工具条上、窄、占位说「在当前文件夹中过滤」。
          与全库搜索（页头那条宽输入 + 放大镜 + 结果分组）形态刻意不同。 */}
      <label className="flex h-7 w-[220px] items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2">
        <Search size={12} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder={S.folderFilter}
          className="min-w-0 flex-1 bg-transparent text-meta text-ink-fg outline-none placeholder:text-ink-fg-3"
        />
      </label>

      <div className="relative">
        <button
          ref={sortRef}
          type="button"
          onClick={() => setSortOpen((v) => !v)}
          className="h-7 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          {S.sort[sort]}
        </button>
        <Popmenu
          open={sortOpen}
          onClose={() => setSortOpen(false)}
          ariaLabel="排序"
          triggerRef={sortRef}
          width={200}
          items={sortItems}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {right}
        <SegmentedControl
          value={view}
          onChange={onView}
          ariaLabel="视图"
          options={[
            { value: 'grid', label: S.view.grid },
            { value: 'list', label: S.view.list }
          ]}
        />
      </div>
    </div>
  )
}

/* ── 网格 ───────────────────────────────────────────────────────── */

function Tile({
  file,
  onOpen,
  onMenu
}: {
  file: LibFile
  onOpen(): void
  onMenu(el: HTMLButtonElement): void
}): React.ReactElement {
  const tone = toneOf(file)
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
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-md border',
          tone.bg,
          tone.border
        )}
        aria-label={`打开 ${file.filename}`}
      >
        <I size={16} strokeWidth={2} className={tone.text} />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 self-center text-left">
        <div className="truncate text-aux font-medium text-ink-fg">{displayName(file)}</div>
        <div className="font-mono text-meta tabular-nums text-ink-fg-2">
          {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'}
          <span className="mx-1 text-ink-fg-3">·</span>
          <span>{KIND_LABEL[file.kind]}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Pill tone={file.source === 'mail' ? 'info' : file.source === 'agent' ? 'ai' : 'ink'}>
            {sourceLabel(file)}
          </Pill>
          <TextStatusPill file={file} />
          <StatusPill file={file} />
        </div>
      </button>
      <button
        type="button"
        aria-label="更多"
        onClick={(e) => onMenu(e.currentTarget)}
        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-ink-fg group-hover/tile:opacity-100"
      >
        <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}

/* ── 列表 ───────────────────────────────────────────────────────── */

function Row({
  file,
  onOpen,
  onMenu,
  showSource
}: {
  file: LibFile
  onOpen(): void
  onMenu(el: HTMLButtonElement): void
  showSource: boolean
}): React.ReactElement {
  const tone = toneOf(file)
  const I = tone.Icon
  return (
    <div
      className={cn(
        'group/row grid items-center gap-3 border-b border-ink-border-soft px-3 py-1.5 text-aux',
        'hover:bg-ink-3/60',
        file.status !== 'present' && 'opacity-60'
      )}
      style={{
        gridTemplateColumns: showSource
          ? '20px minmax(0,2.2fr) 78px 124px 74px minmax(0,1.6fr) 88px 28px'
          : '20px minmax(0,2.6fr) 78px 124px 74px minmax(0,1.2fr) 88px 28px'
      }}
    >
      <span className={cn('grid size-5 place-items-center rounded', tone.bg)}>
        <I size={12} strokeWidth={2} className={tone.text} />
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <span className="block truncate text-ink-fg">{displayName(file)}</span>
        {file.title && file.kind === 'markdown' ? (
          <span className="block truncate font-mono text-micro text-ink-fg-3">{file.filename}</span>
        ) : null}
      </button>
      <span className="font-mono text-meta tabular-nums text-ink-fg-2">
        {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'}
      </span>
      <span className="font-mono text-meta tabular-nums text-ink-fg-2">
        {shortTime(file.mtime)}
      </span>
      <span className="text-meta text-ink-fg-2">{KIND_LABEL[file.kind]}</span>
      <span className="min-w-0 truncate text-meta text-ink-fg-2" title={file.source_ref}>
        {file.source_ref ?? sourceLabel(file)}
      </span>
      <span className="text-meta text-ink-fg-2">{creatorLabel(file)}</span>
      <button
        type="button"
        aria-label="更多"
        onClick={(e) => onMenu(e.currentTarget)}
        className="grid size-6 place-items-center rounded text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-ink-fg group-hover/row:opacity-100"
      >
        <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}

function ListHeader({ showSource }: { showSource: boolean }): React.ReactElement {
  return (
    <div
      className="grid items-center gap-3 border-b border-ink-border px-3 py-1.5 text-micro font-mono uppercase tracking-widest text-ink-fg-3"
      style={{
        gridTemplateColumns: showSource
          ? '20px minmax(0,2.2fr) 78px 124px 74px minmax(0,1.6fr) 88px 28px'
          : '20px minmax(0,2.6fr) 78px 124px 74px minmax(0,1.2fr) 88px 28px'
      }}
    >
      <span />
      <span>{S.col.name}</span>
      <span>{S.col.size}</span>
      <span>{S.col.mtime}</span>
      <span>{S.col.kind}</span>
      <span>{S.col.source}</span>
      <span>{S.col.creator}</span>
      <span />
    </div>
  )
}

/* ── 主体 ───────────────────────────────────────────────────────── */

export interface FolderBodyProps {
  files: LibFile[]
  view: ViewMode
  /** 投影区顶部常驻说明 + 来源列改成「邮件主题 + 发件人」。 */
  projection?: boolean
  /** 空文件夹 / 拖入中 / 索引扫描中。 */
  state?: 'normal' | 'empty' | 'dragging' | 'scanning'
  folderName?: string
  scanProgress?: { done: number; total: number }
  onOpen(file: LibFile): void
  fileMenuItems(file: LibFile): readonly PopmenuItem[]
}

export function FolderBody({
  files,
  view,
  projection = false,
  state = 'normal',
  folderName = '',
  scanProgress,
  onOpen,
  fileMenuItems
}: FolderBodyProps): React.ReactElement {
  const [menuFile, setMenuFile] = React.useState<LibFile | null>(null)
  const menuTrigger = React.useRef<HTMLButtonElement | null>(null)

  const openMenu = (file: LibFile, el: HTMLButtonElement): void => {
    menuTrigger.current = el
    setMenuFile(file)
  }

  return (
    <div className="relative min-h-[320px] flex-1 overflow-y-auto scrollbar-thin">
      {projection ? (
        <div className="sticky top-0 z-10 border-b border-ink-border-soft bg-ink-1/95 px-4 py-1.5 text-meta text-ink-fg-2 backdrop-blur-none">
          {S.projectionNotice}
        </div>
      ) : null}

      {state === 'scanning' && scanProgress ? (
        <div className="flex items-center gap-2 border-b border-ink-border-soft px-4 py-2 text-meta text-ink-fg-2">
          <Loader2 size={13} className="animate-spin text-ink-fg-3" aria-hidden />
          <span>{S.scanning(scanProgress.done, scanProgress.total)}</span>
          <span className="ml-2 h-1 w-40 overflow-hidden rounded-full bg-ink-4">
            <span
              className="block h-full rounded-full bg-coral transition-[width] duration-base"
              style={{ width: `${Math.round((scanProgress.done / scanProgress.total) * 100)}%` }}
            />
          </span>
        </div>
      ) : null}

      {state === 'empty' ? (
        <div className="grid place-items-center gap-1 px-6 py-16 text-center">
          <div className="text-aux text-ink-fg-1">{S.emptyFolder}</div>
          <div className="text-meta text-ink-fg-3">{S.emptyFolderHint}</div>
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-2 p-3">
          {files.map((f) => (
            <Tile key={f.id} file={f} onOpen={() => onOpen(f)} onMenu={(el) => openMenu(f, el)} />
          ))}
        </div>
      ) : (
        <div>
          <ListHeader showSource={projection} />
          {files.map((f) => (
            <Row
              key={f.id}
              file={f}
              showSource={projection}
              onOpen={() => onOpen(f)}
              onMenu={(el) => openMenu(f, el)}
            />
          ))}
        </div>
      )}

      {state === 'dragging' ? (
        <div className="mk-dropzone pointer-events-none absolute inset-2 grid place-items-center rounded-[var(--r-card)]">
          <span className="rounded-full bg-ink-0/85 px-3 py-1.5 text-aux font-medium text-ink-fg">
            {S.dropHere(folderName)}
          </span>
        </div>
      ) : null}

      {menuFile ? (
        <Popmenu
          open
          onClose={() => setMenuFile(null)}
          ariaLabel={`${menuFile.filename} 菜单`}
          title={menuFile.filename}
          portal
          align="end"
          width={252}
          triggerRef={menuTrigger}
          items={fileMenuItems(menuFile)}
        />
      ) : null}
    </div>
  )
}
