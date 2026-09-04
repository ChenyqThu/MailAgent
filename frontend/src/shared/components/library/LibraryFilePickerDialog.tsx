// 从资料库挑文件（design §9.5 的 LibraryPickerDialog；形态逐属性抄 mockup G 场景里的
// `LibraryPicker` —— 外壳 grid-rows / 两 tab / PickRow / 底部条都在那份原型里定死了）。
//
// 与同目录 `FolderPickerDialog` 是两件事：那个选**目标文件夹**（写入去处，只读区必须禁选），
// 这个选**若干个文件**（拿去读，只读区照样能选）。所以这里的禁选判据只剩「读不到」一种：
//   · 挂载卷被拔了 / 目录移走（`unavailable`）—— 树上灰掉；
//   · 废纸篓整支不进树 —— 选一个待清理的文件当附件没有意义。
//   🔴 投影根（邮件附件）**可选**：`_assert_writable` 管的是写，读不受限。
//
// 🔴 投影行没有 library id（`id: null`，只有 `attachment_id`）—— 本组件把两种行**原样**
// 交给调用方，身份键走 `fileMeta.refOf/refKey` 那一份寻址单源，不在这里替调用方决定它该
// 落成哪种引用（compose 侧：库内行 → `library_file_id`，投影行 → 已有的 `attachment_id` 腿）。
//
// 组件只负责「选」：不上传、不发送、不碰附件列表。

import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip, Search } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { LibrarySearchWarnings } from '@shared/components/command/LibraryHitRow'
import { libraryAddressableHits } from '@shared/components/command/paletteLibrary'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { FileTree, type FileTreeNode } from '@shared/components/ui/FileTree'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'

import { displayName, libraryIconTone, refKey, refOf, rootLabelKey } from './fileMeta'
import { useLibraryFolderPages, useLibrarySearchQuery, useLibraryTreeQuery } from './hooks'
import { Notice } from './parts'
import {
  BUILT_IN_ROOT_SLUGS,
  buildLibraryTree,
  MOUNTS_GROUP_PATH,
  type LibraryTreeNode
} from './tree'

type PickerTab = 'tree' | 'search'

/** 缺省落「我的文档」—— 与资料库页自己的缺省（`state/library-tree.ts` 的
 *  `DEFAULT_SELECTED_PATH`）保持同一个去处；那个常量没导出，字面量在仓里已有两处同源用法。 */
const DEFAULT_FOLDER = 'my-docs'

/** 文件夹页签按最近改动排 —— 挑附件时刚动过的文件命中率最高（与资料库页的出厂排序同档）。 */
const PICKER_SORT = { sort: 'date', dir: 'desc' } as const

/** 选中集的身份键 —— 走 `fileMeta` 那一份寻址单源（库内行 `f:{id}` / 投影行 `a:{attachment_id}`）。
 *  两者都没有的行不可选（服务端不产这种行，返回 null 是类型上的守卫）。 */
function fileKey(file: LibraryFile): string | null {
  const ref = refOf(file)
  return ref === null ? null : refKey(ref)
}

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  /** 确认时把选中的文件对象**原样**交出去（含投影行）。 */
  onConfirm(files: readonly LibraryFile[]): void
}

function PickRow({
  file,
  checked,
  onToggle
}: {
  file: LibraryFile
  checked: boolean
  onToggle(): void
}): ReactElement {
  const tone = libraryIconTone(file)
  const Icon = tone.Icon
  return (
    <label
      data-testid="library-picker-row"
      className="flex cursor-pointer items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2/60 px-3 py-2"
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={displayName(file)}
        className="mt-0.5"
      />
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded', tone.bg)}>
        <Icon size={11} strokeWidth={2} className={tone.text} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-aux text-ink-fg">{displayName(file)}</span>
        {/* 虚拟路径（不是 rel_path）：搜索结果跨根，同名文件只靠根 slug 才分得开。 */}
        <span className="mt-0.5 block truncate font-mono text-micro text-ink-fg-3">
          {file.path}
        </span>
      </span>
    </label>
  )
}

/** 文件夹页签的右半：当前文件夹里的文件（子文件夹靠左树导航，不在这里再画一遍）。 */
function FolderFiles({
  folder,
  isPicked,
  onToggle
}: {
  folder: string
  isPicked(file: LibraryFile): boolean
  onToggle(file: LibraryFile): void
}): ReactElement {
  const { t } = useTranslation()
  const pages = useLibraryFolderPages(folder, PICKER_SORT)
  const files = useMemo(() => (pages.data?.pages ?? []).flatMap((page) => page.files), [pages.data])

  if (pages.isPending) return <Skeleton rows={4} className="p-1" width="2/3" />
  if (pages.isError) {
    return (
      <Notice tone="fail">
        {t('library.folder.loadFailed')}
        <span className="ml-1.5 text-ink-fg-3">{errorMessage(pages.error)}</span>
      </Notice>
    )
  }
  if (files.length === 0) {
    return (
      <div
        data-testid="library-picker-empty-folder"
        className="px-2 py-6 text-center text-meta text-ink-fg-3"
      >
        {t('library.picker.emptyFolder')}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {files.map((file) => (
        <PickRow
          key={fileKey(file) ?? file.path}
          file={file}
          checked={isPicked(file)}
          onToggle={() => onToggle(file)}
        />
      ))}
      {pages.hasNextPage ? (
        <button
          type="button"
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
          className="w-full rounded-[var(--r-ctl)] px-3 py-2 text-meta text-ink-fg-2 hover:bg-ink-3 disabled:opacity-50"
        >
          {t('library.folder.loadMore')}
        </button>
      ) : null}
    </div>
  )
}

/** 搜索页签。恒发 `hybrid`（没下载语义模型时服务端自己退化成纯 FTS，形状不变）。
 *  🔴 `warnings` 非空的零命中是「这次根本没查」（中文 1 字），不能渲染成「没有匹配的文件」。 */
function SearchFiles({
  query,
  isPicked,
  onToggle
}: {
  query: string
  isPicked(file: LibraryFile): boolean
  onToggle(file: LibraryFile): void
}): ReactElement | null {
  const { t } = useTranslation()
  const search = useLibrarySearchQuery(query, 'hybrid')

  // 空 query 不发请求（hook 的 `enabled`）—— 此时 isPending 恒真，画骨架会是永久骨架。
  if (query.trim() === '') return null
  if (search.isPending) return <Skeleton rows={4} className="p-1" width="2/3" />
  if (search.isError) {
    return (
      <Notice tone="fail">
        {t('library.folder.loadFailed')}
        <span className="ml-1.5 text-ink-fg-3">{errorMessage(search.error)}</span>
      </Notice>
    )
  }

  const hits = libraryAddressableHits(search.data.hits)
  return (
    <div className="space-y-1">
      <LibrarySearchWarnings warnings={search.data.warnings} className="px-1 py-1" />
      {hits.map((hit) => (
        <PickRow key={hit.id} file={hit} checked={isPicked(hit)} onToggle={() => onToggle(hit)} />
      ))}
      {hits.length === 0 && search.data.warnings.length === 0 ? (
        <div
          data-testid="library-picker-search-empty"
          className="grid place-items-center gap-1 px-6 py-10 text-center"
        >
          <div className="text-aux text-ink-fg-1">{t('library.search.empty')}</div>
          <div className="text-meta text-ink-fg-3">{t('library.search.emptyHint')}</div>
        </div>
      ) : null}
    </div>
  )
}

export function LibraryFilePickerDialog({ open, onOpenChange, onConfirm }: Props): ReactElement {
  const { t } = useTranslation()
  const [tab, setTab] = useState<PickerTab>('tree')
  const [folder, setFolder] = useState(DEFAULT_FOLDER)
  const [query, setQuery] = useState('')
  // 选中的是**文件对象**而不是 id：确认时调用方要文件名 / 大小，回头再查一次没有意义。
  // 跨文件夹、跨页签累加，所以按寻址键去重而不是按当前列表位置。
  const [picked, setPicked] = useState<readonly { key: string; file: LibraryFile }[]>([])

  const tree = useLibraryTreeQuery(open)
  const [expanded, setExpanded] = useState<string[]>([...BUILT_IN_ROOT_SLUGS, MOUNTS_GROUP_PATH])

  const roots = useMemo(
    () => buildLibraryTree({ folders: tree.data?.folders ?? [], mounts: tree.data?.mounts ?? [] }),
    [tree.data]
  )
  const nodes = useMemo(() => {
    const toNode = (node: LibraryTreeNode): FileTreeNode => ({
      value: node.path,
      name:
        node.kind === 'group' || (node.kind === 'root' && node.mount === null)
          ? t(rootLabelKey(node.path))
          : node.name,
      type: 'folder',
      // 只读根照样能选（读不受限）；读不到的挂载才禁。
      disabled: node.kind !== 'group' && node.unavailable,
      muted: node.kind === 'group',
      children: node.children.map(toNode)
    })
    return roots.filter((r) => r.kind !== 'trash').map(toNode)
  }, [roots, t])

  const pickedKeys = useMemo(() => new Set(picked.map((p) => p.key)), [picked])
  const isPicked = (file: LibraryFile): boolean => {
    const key = fileKey(file)
    return key !== null && pickedKeys.has(key)
  }
  const toggle = (file: LibraryFile): void => {
    const key = fileKey(file)
    if (key === null) return
    setPicked((prev) =>
      prev.some((p) => p.key === key) ? prev.filter((p) => p.key !== key) : [...prev, { key, file }]
    )
  }

  const close = (): void => {
    setPicked([])
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPicked([])
        onOpenChange(next)
      }}
    >
      <DialogContent className="grid-rows-[auto_auto_1fr_auto] max-h-[84vh] w-[660px] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('library.picker.title')}</DialogTitle>
          <DialogDescription>{t('library.picker.pickHint')}</DialogDescription>
        </DialogHeader>

        <SegmentedControl
          value={tab}
          onChange={(next: PickerTab) => setTab(next)}
          ariaLabel={t('library.picker.title')}
          options={[
            { value: 'tree', label: t('library.picker.tabTree') },
            { value: 'search', label: t('library.picker.tabSearch') }
          ]}
        />

        <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {tab === 'tree' ? (
            <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3">
              <div className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 p-1">
                {tree.isPending ? (
                  <Skeleton rows={4} className="p-2" width="2/3" />
                ) : (
                  <FileTree
                    nodes={nodes}
                    value={folder}
                    onValueChange={(value) => {
                      if (value !== MOUNTS_GROUP_PATH) setFolder(value)
                    }}
                    expandedIds={expanded}
                    onExpandedChange={setExpanded}
                    ariaLabel={t('library.picker.treeAria')}
                  />
                )}
              </div>
              <FolderFiles folder={folder} isPicked={isPicked} onToggle={toggle} />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="flex h-8 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5">
                <Search size={13} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  data-testid="library-picker-search-input"
                  placeholder={t('library.search.placeholder')}
                  aria-label={t('library.picker.tabSearch')}
                  className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
                />
              </label>
              <SearchFiles query={query} isPicked={isPicked} onToggle={toggle} />
            </div>
          )}
        </div>

        <DialogFooter className="items-center justify-start gap-3">
          <span className="text-aux text-ink-fg-3">
            {t('library.picker.selectedCount', { n: picked.length })}
          </span>
          <Button variant="ghost" className="ml-auto" onClick={close}>
            {t('library.actions.cancel')}
          </Button>
          <Button
            disabled={picked.length === 0}
            onClick={() => {
              onConfirm(picked.map((p) => p.file))
              close()
            }}
          >
            <Paperclip size={13} aria-hidden />
            {t('library.picker.confirmAttach')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
