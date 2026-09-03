// 二级栏的文件夹树（design §2.2 / §8.2；mockup A1–A3）：多根 + 挂载分组 + 废纸篓，选中 pill /
// 文件数角标 / 只读锁 / 不可用警示 / 节点右键菜单。呈现层是收编的 `ui/FileTree`，数据层是
// `components/library/tree.ts`；这里只做「树节点 → FileTreeNode」的映射与菜单。
//
// i18n：内置根按 slug 直查 `library.tree.roots.<slug>`；两处 path→key 偏移在这里处理 ——
// 废纸篓 path 是 `.trash`（key `trash`），挂载分组头是合成的 `__mounts__`（key `mounts`）。

import { useMemo, useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ExternalLink, Lock, Mail, MessagesSquare, Trash2, TriangleAlert, User } from 'lucide-react'

import { FileTree, type FileTreeNode } from '@shared/components/ui/FileTree'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { PROJECTION_SLUG, TRASH_SLUG } from '@shared/libraryConstants'

import { useCursorMenu } from './cursorMenu'
import { useLibraryTreeQuery } from './hooks'
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
  }, [menu.payload, onNewMarkdown, onReveal, t])

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
            if (target && target.kind !== 'group' && !target.unavailable) menu.openAt(event, target)
          }}
        />
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
