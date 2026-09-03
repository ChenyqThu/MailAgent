// 二级栏的文件夹树（design §2.2 / §8.2；mockup A1–A3）：多根 + 挂载分组 + 废纸篓，选中 pill /
// 文件数角标 / 只读锁 / 不可用警示 / 节点右键菜单。呈现层是收编的 `ui/FileTree`，数据层是
// `components/library/tree.ts`；这里只做「树节点 → FileTreeNode」的映射与菜单。
//
// i18n：内置根按 slug 直查 `library.tree.roots.<slug>`；两处 path→key 偏移在这里处理 ——
// 废纸篓 path 是 `.trash`（key `trash`），挂载分组头是合成的 `__mounts__`（key `mounts`）。
//
// 挂载根（design §8.2）：底部「添加文件夹」+ 根节点菜单（重命名标签 / 切只读 / 在访达中显示 /
// 卸载）。🔴 树里**没有绝对路径可显示** —— 数据来自 `GET /library/tree` 内嵌的
// `LibraryMountSummary`，那个类型没有 `abs_path` 字段。

import { useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  ExternalLink,
  Lock,
  Mail,
  MessagesSquare,
  Plus,
  Trash2,
  TriangleAlert,
  User
} from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { FileTree, type FileTreeNode } from '@shared/components/ui/FileTree'
import { Input } from '@shared/components/ui/input'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { PROJECTION_SLUG, TRASH_SLUG } from '@shared/libraryConstants'
import { toastError } from '@shared/state/toast'

import { useAddMountFlow } from './useAddMountFlow'
import { useCursorMenu } from './cursorMenu'
import { useLibraryTreeQuery } from './hooks'
import { mountErrorText, useMountMutations } from './mountHooks'
import {
  buildLibraryTree,
  MOUNTS_GROUP_PATH,
  type LibraryTreeNode
} from './tree'

const ICON_SIZE = 14

const ROOT_ICONS: Record<string, ReactElement> = {
  'mail-attachments': <Mail size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
  'chat-attachments': <MessagesSquare size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
  'agent-docs': <Bot size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
  'my-docs': <User size={ICON_SIZE} strokeWidth={1.9} aria-hidden />
}

export function rootLabelKey(path: string): string {
  if (path === TRASH_SLUG) return 'library.tree.roots.trash'
  if (path === MOUNTS_GROUP_PATH) return 'library.tree.roots.mounts'
  return `library.tree.roots.${path}`
}

interface Props {
  selectedPath: string | null
  expanded: ReadonlySet<string>
  onSelectFolder(path: string): void
  onExpandedChange(next: string[]): void
  onNewMarkdown(folderPath: string): void
  onImportFiles(folderPath: string, files: File[]): void
  onReveal(folderPath: string): void
}

export function LibraryTreePanel({
  selectedPath,
  expanded,
  onSelectFolder,
  onExpandedChange,
  onNewMarkdown,
  onImportFiles,
  onReveal
}: Props): ReactElement {
  const { t } = useTranslation()
  const tree = useLibraryTreeQuery()
  const menu = useCursorMenu<LibraryTreeNode>()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const importTarget = useRef<string | null>(null)
  const addMount = useAddMountFlow()
  const mounts = useMountMutations()
  const [renaming, setRenaming] = useState<{ id: number; label: string } | null>(null)
  const [unmounting, setUnmounting] = useState<{ id: number; label: string } | null>(null)

  const roots = useMemo(
    () =>
      buildLibraryTree({
        folders: tree.data?.folders ?? [],
        mounts: tree.data?.mounts ?? []
      }),
    [tree.data]
  )
  const byPath = useMemo(() => {
    const map = new Map<string, LibraryTreeNode>()
    const walk = (nodes: readonly LibraryTreeNode[]): void => {
      for (const node of nodes) {
        map.set(node.path, node)
        walk(node.children)
      }
    }
    walk(roots)
    return map
  }, [roots])

  const nodes = useMemo(() => {
    const toNode = (node: LibraryTreeNode): FileTreeNode => {
      let name = node.name
      let icon: ReactElement | undefined
      if (node.kind === 'group') {
        name = t('library.tree.roots.mounts')
        icon = <span />
      } else if (node.kind === 'trash') {
        name = t('library.tree.roots.trash')
        icon = <Trash2 size={ICON_SIZE} strokeWidth={1.9} aria-hidden />
      } else if (node.kind === 'root' && node.mount !== null) {
        icon = <ExternalLink size={ICON_SIZE} strokeWidth={1.9} aria-hidden />
      } else if (node.kind === 'root') {
        name = t(rootLabelKey(node.path))
        icon = ROOT_ICONS[node.path]
      } else if (node.path === `${PROJECTION_SLUG}/unknown`) {
        // 服务端把 date_received 为空的附件落进字面量 `unknown` 桶，别让它裸露。
        name = t('library.folder.unknownDateGroup')
      }
      const trailing =
        node.unavailable || node.readonly || node.fileCount > 0 ? (
          <span className="flex items-center gap-1">
            {node.unavailable ? (
              <TriangleAlert size={11} strokeWidth={2} className="text-warn" aria-hidden />
            ) : node.readonly ? (
              <Lock size={10} strokeWidth={2} className="text-ink-fg-3" aria-hidden />
            ) : null}
            {node.fileCount > 0 ? (
              <span className="font-mono tabular-nums">{node.fileCount}</span>
            ) : null}
          </span>
        ) : undefined
      return {
        value: node.path,
        name,
        type: 'folder',
        icon,
        trailing,
        disabled: node.unavailable,
        className:
          node.kind === 'group'
            ? 'mt-3 text-micro font-mono uppercase tracking-widest text-ink-fg-3'
            : undefined,
        children: node.children.map(toNode)
      }
    }
    return roots.map(toNode)
  }, [roots, t])

  const menuItems = useMemo((): readonly PopmenuItem[] => {
    const node = menu.payload
    if (node === null) return []
    if (node.kind === 'trash') return [{ kind: 'label', id: 'notice', label: t('library.trash.notice') }]
    if (node.path.startsWith(PROJECTION_SLUG)) {
      return [
        { kind: 'label', id: 'ro', label: t('library.tree.readonlyRoot') },
        {
          kind: 'action',
          id: 'reveal',
          label: t('library.tree.menu.revealInFinder'),
          disabled: true,
          onSelect: () => undefined
        }
      ]
    }
    const reveal: PopmenuItem = {
      kind: 'action',
      id: 'reveal',
      label: t('library.tree.menu.revealInFinder'),
      onSelect: () => onReveal(node.path)
    }
    // 挂载根：这一支必须排在 `node.readonly` 短路之前 —— 只读挂载根照样要能改名 / 切回可写 / 卸载。
    if (node.kind === 'root' && node.mount !== null) {
      const mount = node.mount
      const unmount: PopmenuItem = {
        kind: 'action',
        id: 'unmount',
        tone: 'danger',
        label: t('library.tree.menu.unmount'),
        onSelect: () => setUnmounting({ id: mount.id, label: mount.label })
      }
      // 卷拔了 / 目录移走：读盘的动作全无意义，但卸载必须留着，否则这一根永远摘不掉。
      if (node.unavailable) return [unmount]
      const toMode = mount.mode === 'ro' ? 'rw' : 'ro'
      return [
        {
          kind: 'action',
          id: 'rename-label',
          label: t('library.tree.menu.renameLabel'),
          onSelect: () => setRenaming({ id: mount.id, label: mount.label })
        },
        {
          kind: 'action',
          id: 'toggle-mode',
          label: t(toMode === 'ro' ? 'library.tree.menu.toReadonly' : 'library.tree.menu.toWritable'),
          // 🔴 切只读**不问**有没有文件正在编辑：F5 拍板是「编辑器降级只读并保留未保存文本」，
          // 不是拒绝切换。降级由 `FilePreview` 按 `mount.mode` 自己完成（本次 PATCH 失效树查询
          // → 它读到 ro → 编辑面收起，草稿留在编辑器 state 里）。
          onSelect: () => {
            void mounts.patch(mount.id, { mode: toMode }).catch((err: unknown) => {
              toastError(
                t(toMode === 'ro' ? 'library.tree.menu.toReadonly' : 'library.tree.menu.toWritable'),
                mountErrorText(err)
              )
            })
          }
        },
        { kind: 'separator', id: 's0' },
        reveal,
        { kind: 'separator', id: 's1' },
        unmount
      ]
    }
    if (node.readonly) return [reveal]
    return [
      {
        kind: 'action',
        id: 'newmd',
        label: t('library.tree.menu.newMarkdown'),
        onSelect: () => onNewMarkdown(node.path)
      },
      {
        kind: 'action',
        id: 'import',
        label: t('library.tree.menu.importFile'),
        onSelect: () => {
          importTarget.current = node.path
          fileInput.current?.click()
        }
      },
      { kind: 'separator', id: 's1' },
      reveal
    ]
  }, [menu.payload, mounts, onNewMarkdown, onReveal, t])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="nav-panel-header shrink-0">
        <span className="flex-1 truncate text-body font-medium text-ink-fg">
          {t('library.tree.domainTitle')}
        </span>
        {tree.data ? (
          <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
            {tree.data.file_count}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 scrollbar-thin">
        <FileTree
          nodes={nodes}
          value={selectedPath}
          onValueChange={(value) => {
            // 分组头只负责展开折叠，不是文件夹。
            if (value !== MOUNTS_GROUP_PATH) onSelectFolder(value)
          }}
          expandedIds={[...expanded]}
          onExpandedChange={onExpandedChange}
          ariaLabel={t('library.tree.domainTitle')}
          onNodeContextMenu={(node, event) => {
            const target = byPath.get(node.value)
            if (!target || target.kind === 'group') return
            // 不可用的挂载根仍要能右键 —— 「卸载」是它唯一的出口（卷拔了 / 目录移走）。
            const isMountRoot = target.kind === 'root' && target.mount !== null
            if (target.unavailable && !isMountRoot) return
            menu.openAt(event, target)
          }}
        />
        <button
          type="button"
          onClick={() => void addMount.begin()}
          className="mt-2 flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-body text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <span className="grid w-3.5 shrink-0 place-items-center" />
          <Plus size={ICON_SIZE} strokeWidth={2} aria-hidden />
          <span className="flex-1 truncate">{t('library.tree.addFolder')}</span>
        </button>
      </div>
      <span {...menu.anchorProps} />
      <Popmenu
        open={menu.open && menuItems.length > 0}
        onClose={menu.close}
        ariaLabel={t('library.tree.nodeMenuAria', { name: menu.payload?.name ?? '' })}
        portal
        triggerRef={menu.anchorRef}
        align="start"
        width={240}
        items={menuItems}
      />
      {addMount.dialog}
      <RenameMountDialog
        target={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={(label) =>
          mounts.patch(renaming?.id ?? 0, { label }).then(
            () => setRenaming(null),
            (err: unknown) => toastError(t('library.tree.menu.renameLabel'), mountErrorText(err))
          )
        }
        busy={mounts.busy}
      />
      <UnmountDialog
        target={unmounting}
        onClose={() => setUnmounting(null)}
        onConfirm={() =>
          mounts.remove(unmounting?.id ?? 0).then(
            () => setUnmounting(null),
            (err: unknown) => toastError(t('library.tree.menu.unmount'), mountErrorText(err))
          )
        }
        busy={mounts.busy}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const folder = importTarget.current
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          importTarget.current = null
          if (folder && files.length > 0) onImportFiles(folder, files)
        }}
      />
    </div>
  )
}

interface MountTarget {
  id: number
  label: string
}

/** 重命名挂载标签。改的是 `@label` 这个虚拟路径前缀，磁盘上什么都不动。 */
function RenameMountDialog({
  target,
  onClose,
  onSubmit,
  busy
}: {
  target: MountTarget | null
  onClose(): void
  onSubmit(label: string): void
  busy: boolean
}): ReactElement {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {target !== null ? (
        // key = 挂载 id：换一根时重挂，输入框回到那一根的当前标签。
        <RenameMountBody key={target.id} target={target} onClose={onClose} onSubmit={onSubmit} busy={busy} />
      ) : null}
    </Dialog>
  )
}

function RenameMountBody({
  target,
  onClose,
  onSubmit,
  busy
}: {
  target: MountTarget
  onClose(): void
  onSubmit(label: string): void
  busy: boolean
}): ReactElement {
  const { t } = useTranslation()
  const [label, setLabel] = useState(target.label)
  const trimmed = label.trim()
  return (
    <DialogContent className="w-[440px]">
      <DialogHeader>
        <DialogTitle>{t('library.tree.menu.renameLabel')}</DialogTitle>
      </DialogHeader>
      <label className="block">
        <span className="mb-1 block text-aux text-ink-fg-1">{t('library.mount.label')}</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        <span className="mt-1 block font-mono text-meta text-ink-fg-3">
          @{trimmed === '' ? target.label : trimmed}
        </span>
      </label>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('library.actions.cancel')}
        </Button>
        <Button size="sm" disabled={busy || trimmed === ''} onClick={() => onSubmit(trimmed)}>
          {t('library.actions.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

/** 卸载确认。🔴 正文说的是 F5 拍板的语义：**不删行、不动磁盘** —— 挂载行标 `unmounted`、
 *  其下文件行标 `missing`，事项 / 会话里的 `library:{id}` 引用灰显而不是悬空，重新挂回同一
 *  目录会沿用原来的文件 id。 */
function UnmountDialog({
  target,
  onClose,
  onConfirm,
  busy
}: {
  target: MountTarget | null
  onClose(): void
  onConfirm(): void
  busy: boolean
}): ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {target !== null ? (
        <DialogContent className="w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {t('library.tree.menu.unmount')} @{target.label}
            </DialogTitle>
            <DialogDescription>{t('library.tree.menu.unmountHint')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('library.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
              {t('library.tree.menu.unmount')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
