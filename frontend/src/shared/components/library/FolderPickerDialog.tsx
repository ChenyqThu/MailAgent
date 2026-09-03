// 目标文件夹选择（mockup C11「另存到资料库」/ C12「移到…」同一个组件参数化）。
// 树来自 `GET /library/tree`；只读区（投影根 / ro 或不可用挂载 / 废纸篓）与调用方点名的路径禁选。

import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Button } from '@shared/components/ui/button'
import { FileTree, type FileTreeNode } from '@shared/components/ui/FileTree'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { PROJECTION_SLUG, TRASH_SLUG } from '@shared/libraryConstants'

import { useLibraryTreeQuery } from './hooks'
import { rootLabelKey } from './LibraryTreePanel'
import { BUILT_IN_ROOT_SLUGS, buildLibraryTree, MOUNTS_GROUP_PATH, type LibraryTreeNode } from './tree'

export type FolderPickerMode = 'move' | 'keep'

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  mode: FolderPickerMode
  /** 被移动 / 被另存的文件：显示名进描述句，`path` 给「从 → 到」预览。
   *  `path` 只在 `move` 档用得着 —— `keep` 的来源是邮件附件，它在库里还没有路径。 */
  file: { filename: string; path?: string }
  /** 额外禁选的文件夹（如「移到…」里文件当前所在的文件夹）。 */
  disabledPaths?: readonly string[]
  busy?: boolean
  onConfirm(targetPath: string): void
}

function selectable(node: LibraryTreeNode): boolean {
  if (node.kind === 'group' || node.kind === 'trash') return false
  if (node.readonly || node.unavailable) return false
  return !node.path.startsWith(PROJECTION_SLUG) && node.path !== TRASH_SLUG
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  mode,
  file,
  disabledPaths = [],
  busy = false,
  onConfirm
}: Props): ReactElement {
  const { t } = useTranslation()
  const tree = useLibraryTreeQuery(open)
  const [target, setTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string[]>([...BUILT_IN_ROOT_SLUGS, MOUNTS_GROUP_PATH])

  const roots = useMemo(
    () => buildLibraryTree({ folders: tree.data?.folders ?? [], mounts: tree.data?.mounts ?? [] }),
    [tree.data]
  )
  const nodes = useMemo(() => {
    const toNode = (node: LibraryTreeNode): FileTreeNode => {
      const disabled =
        !selectable(node) && node.kind !== 'group'
          ? true
          : disabledPaths.some((p) => node.path === p)
      const name =
        node.kind === 'group' || node.kind === 'trash'
          ? t(rootLabelKey(node.path))
          : node.kind === 'root' && node.mount === null
            ? t(rootLabelKey(node.path))
            : node.name
      return {
        value: node.path,
        name,
        type: 'folder',
        disabled: node.kind === 'group' ? false : disabled,
        muted: node.kind === 'group',
        children: node.children.map(toNode)
      }
    }
    // 投影根与废纸篓整支不进选择器。
    return roots.filter((r) => r.path !== PROJECTION_SLUG && r.kind !== 'trash').map(toNode)
  }, [disabledPaths, roots, t])

  const confirmable = target !== null && target !== MOUNTS_GROUP_PATH && !busy

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTarget(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {mode === 'keep' ? t('library.actions.keepToLibrary') : t('library.actions.moveTo')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'keep'
              ? t('library.picker.keepDesc', { name: file.filename })
              : t('library.picker.moveDesc', { name: file.filename })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          <div className="max-h-64 overflow-y-auto rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 p-1 scrollbar-thin">
            {tree.isPending ? (
              <Skeleton rows={4} className="p-2" width="2/3" />
            ) : (
              <FileTree
                nodes={nodes}
                value={target}
                onValueChange={(value) => {
                  if (value !== MOUNTS_GROUP_PATH) setTarget(value)
                }}
                expandedIds={expanded}
                onExpandedChange={setExpanded}
                ariaLabel={t('library.picker.treeAria')}
              />
            )}
          </div>
          {mode === 'keep' ? (
            <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 font-mono text-micro text-ink-fg-3">
              {target ?? '…'}/{file.filename}
            </div>
          ) : (
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 font-mono text-micro">
              <span className="text-ink-fg-3">{t('library.picker.from')}</span>
              <span className="text-ink-fg-2">{file.path}</span>
              <span className="text-ink-fg-3">{t('library.picker.to')}</span>
              <span className="text-ink-fg">
                {target ?? '…'}/{file.filename}
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('library.actions.cancel')}
          </Button>
          <Button size="sm" disabled={!confirmable} onClick={() => target && onConfirm(target)}>
            {t('library.actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
