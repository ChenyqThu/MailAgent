// 二级栏的文件夹树（design §2.2）。
//
// 落地时呈现层换成收编的 beUI `ui/FileTree`（剥 blur、数据递归、换 motion-tokens），
// 这里先用主仓既有的 authored 类把**信息结构与状态**摆全：多根 / 分组 / 展开折叠 /
// 选中 pill / 文件数角标 / 只读与不可用灰显 / 节点菜单。
//
// 复用的真东西：
//   · authored 类 `.row` / `.row-selected` / `.acc-select`（选中左光条 + accent wash）
//   · `ui/collapsible` 的 CollapseChevron + CollapsibleRegion（grid-rows 折叠原语）
//   · `ui/Popmenu`（右键 / 「…」菜单）
// 假的：数据、点开菜单后的写入（只改本地 state）。

import * as React from 'react'
import {
  Bot,
  ExternalLink,
  Folder,
  FolderOpen,
  Lock,
  Mail,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  TriangleAlert,
  User
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { CollapseChevron } from '@shared/components/ui/collapsible'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'

import { FOLDERS, MOUNTS, type LibMount } from '../fixtures'
import { S } from '../strings'

export type NodeKind = 'root' | 'folder' | 'group' | 'trash'

export interface TreeNode {
  path: string
  name: string
  depth: number
  kind: NodeKind
  count: number
  readonly?: boolean
  unavailable?: boolean
  hint?: string
  mount?: LibMount
  icon: React.ReactNode
  /** 有子节点才画 chevron。 */
  hasChildren: boolean
}

const ICON_SIZE = 14

function childrenOf(path: string): string[] {
  return FOLDERS.filter(
    (f) => f.path.startsWith(`${path}/`) && f.path.slice(path.length + 1).indexOf('/') < 0
  ).map((f) => f.path)
}

function folderMeta(path: string): {
  name: string
  count: number
  readonly?: boolean
  unavailable?: boolean
} {
  const row = FOLDERS.find((f) => f.path === path)
  return {
    name: row?.name ?? path.split('/').pop() ?? path,
    count: row?.count ?? 0,
    readonly: row?.readonly,
    unavailable: row?.unavailable
  }
}

/** 摊平成数组 + depth（照 `folderTree.ts::flattenFolderTree` 的范式，不复用函数）。 */
export function buildTree(expanded: ReadonlySet<string>, mounts: LibMount[]): TreeNode[] {
  const out: TreeNode[] = []

  const pushFolder = (
    path: string,
    depth: number,
    inheritRo: boolean,
    inheritUn: boolean
  ): void => {
    const meta = folderMeta(path)
    const kids = childrenOf(path)
    const ro = inheritRo || meta.readonly === true
    const un = inheritUn || meta.unavailable === true
    out.push({
      path,
      name: meta.name,
      depth,
      kind: 'folder',
      count: meta.count,
      readonly: ro,
      unavailable: un,
      icon: expanded.has(path) ? (
        <FolderOpen size={ICON_SIZE} strokeWidth={1.9} aria-hidden />
      ) : (
        <Folder size={ICON_SIZE} strokeWidth={1.9} aria-hidden />
      ),
      hasChildren: kids.length > 0
    })
    if (!expanded.has(path)) return
    for (const kid of kids) pushFolder(kid, depth + 1, ro, un)
  }

  const pushRoot = (
    path: string,
    label: string,
    icon: React.ReactNode,
    opts: { readonly?: boolean; hint?: string } = {}
  ): void => {
    const kids = childrenOf(path)
    const meta = folderMeta(path)
    out.push({
      path,
      name: label,
      depth: 0,
      kind: 'root',
      count: meta.count,
      readonly: opts.readonly,
      hint: opts.hint,
      icon,
      hasChildren: kids.length > 0
    })
    if (!expanded.has(path)) return
    for (const kid of kids) pushFolder(kid, 1, opts.readonly === true, false)
  }

  pushRoot(
    'mail-attachments',
    S.roots.mail,
    <Mail size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
    {
      readonly: true,
      hint: S.rootHint.mail
    }
  )
  pushRoot(
    'chat-attachments',
    S.roots.chat,
    <MessagesSquare size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
    { hint: S.rootHint.chat }
  )
  pushRoot(
    'agent-docs',
    S.roots.agentDocs,
    <Bot size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
    {
      hint: S.rootHint.agentDocs
    }
  )
  pushRoot('my-docs', S.roots.myDocs, <User size={ICON_SIZE} strokeWidth={1.9} aria-hidden />, {
    hint: S.rootHint.myDocs
  })

  // 挂载分组头（design §8.2：内置四根之下一组「挂载的文件夹」）
  out.push({
    path: '__mounts__',
    name: S.roots.mounts,
    depth: 0,
    kind: 'group',
    count: mounts.length,
    icon: null,
    hasChildren: mounts.length > 0
  })
  if (expanded.has('__mounts__')) {
    for (const m of mounts) {
      const path = `@${m.label}`
      const kids = childrenOf(path)
      out.push({
        path,
        name: path,
        depth: 1,
        kind: 'root',
        count: folderMeta(path).count,
        readonly: m.mode === 'ro',
        unavailable: m.status === 'unavailable',
        mount: m,
        icon: <ExternalLink size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
        hasChildren: kids.length > 0
      })
      if (expanded.has(path) && m.status === 'ok') {
        for (const kid of kids) pushFolder(kid, 2, m.mode === 'ro', false)
      }
    }
  }

  out.push({
    path: '.trash',
    name: S.roots.trash,
    depth: 0,
    kind: 'trash',
    count: folderMeta('.trash').count,
    icon: <Trash2 size={ICON_SIZE} strokeWidth={1.9} aria-hidden />,
    hasChildren: false
  })

  return out
}

/* ── 节点菜单（A3） ──────────────────────────────────────────────── */

export function nodeMenuItems(node: TreeNode, act: (what: string) => void): readonly PopmenuItem[] {
  if (node.kind === 'trash') {
    return [
      { kind: 'label', id: 'l', label: S.trashNotice },
      {
        kind: 'action',
        id: 'empty',
        label: S.menu.emptyTrash,
        tone: 'danger',
        onSelect: () => act('empty-trash')
      }
    ]
  }
  if (node.mount) {
    const m = node.mount
    return [
      { kind: 'label', id: 'l', label: m.abs_path },
      {
        kind: 'action',
        id: 'rename',
        label: S.menu.renameLabel,
        onSelect: () => act('rename-label')
      },
      {
        kind: 'action',
        id: 'mode',
        label: m.mode === 'ro' ? S.menu.toWritable : S.menu.toReadonly,
        onSelect: () => act('toggle-mode')
      },
      { kind: 'separator', id: 's1' },
      { kind: 'action', id: 'reveal', label: S.menu.revealInFinder, onSelect: () => act('reveal') },
      {
        kind: 'action',
        id: 'unmount',
        label: S.menu.unmount,
        hint: S.menu.unmountHint,
        tone: 'danger',
        onSelect: () => act('unmount')
      }
    ]
  }
  if (node.readonly) {
    return [
      { kind: 'label', id: 'l', label: S.readonlyRoot },
      {
        kind: 'action',
        id: 'reveal',
        label: S.menu.revealInFinder,
        disabled: true,
        onSelect: () => act('noop')
      }
    ]
  }
  const base: PopmenuItem[] = [
    { kind: 'action', id: 'newfolder', label: S.menu.newFolder, onSelect: () => act('new-folder') },
    { kind: 'action', id: 'newmd', label: S.menu.newMarkdown, onSelect: () => act('new-md') },
    { kind: 'action', id: 'import', label: S.menu.importFile, onSelect: () => act('import') },
    { kind: 'separator', id: 's1' },
    { kind: 'action', id: 'reveal', label: S.menu.revealInFinder, onSelect: () => act('reveal') }
  ]
  if (node.kind === 'folder') {
    base.push(
      { kind: 'separator', id: 's2' },
      { kind: 'action', id: 'rename', label: S.menu.rename, onSelect: () => act('rename') },
      { kind: 'action', id: 'move', label: S.menu.moveTo, onSelect: () => act('move') },
      {
        kind: 'action',
        id: 'delete',
        label: S.menu.delete,
        tone: 'danger',
        onSelect: () => act('delete')
      }
    )
  }
  return base
}

/* ── 树 ─────────────────────────────────────────────────────────── */

export interface TreeProps {
  selected: string
  onSelect(path: string): void
  expanded: Set<string>
  onToggle(path: string): void
  mounts?: LibMount[]
  /** 拖入中的目标文件夹（B2 的 drop 高亮）。 */
  dropTarget?: string | null
  onAddFolder?(): void
  onNodeAction?(node: TreeNode, what: string): void
  /** 树里显示 iCloud 占位文件行等「文件级」条目（A2 要求）。 */
  showFileRows?: boolean
}

export function LibraryTree({
  selected,
  onSelect,
  expanded,
  onToggle,
  mounts = MOUNTS,
  dropTarget,
  onAddFolder,
  onNodeAction
}: TreeProps): React.ReactElement {
  const nodes = React.useMemo(() => buildTree(expanded, mounts), [expanded, mounts])
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const triggerRefs = React.useRef(new Map<string, HTMLButtonElement>())

  return (
    <div className="flex h-full flex-col">
      <div className="nav-panel-header shrink-0">
        <span className="flex-1 truncate text-body font-medium text-ink-fg">{S.domain}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 scrollbar-thin">
        {nodes.map((node) => {
          const isSel = node.path === selected
          const isDrop = dropTarget === node.path
          const disabled = node.unavailable === true
          if (node.kind === 'group') {
            return (
              <button
                key={node.path}
                type="button"
                onClick={() => onToggle(node.path)}
                className="mt-3 flex w-full items-center gap-1.5 px-2 pb-1 text-left text-micro font-mono uppercase tracking-widest text-ink-fg-3 hover:text-ink-fg-2"
              >
                <CollapseChevron expanded={expanded.has(node.path)} size={11} />
                <span className="flex-1">{node.name}</span>
                <span className="tabular-nums">{node.count}</span>
              </button>
            )
          }
          return (
            <div key={node.path} className="group/row relative">
              <button
                type="button"
                onClick={() => {
                  onSelect(node.path)
                  if (node.hasChildren && !expanded.has(node.path)) onToggle(node.path)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenuFor(node.path)
                }}
                disabled={disabled}
                title={disabled ? S.mountUnavailable : undefined}
                style={{ paddingLeft: 8 + node.depth * 14 }}
                className={cn(
                  'row relative flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] pr-2',
                  'text-left text-body transition-colors duration-fast',
                  isSel
                    ? 'row-selected acc-select font-medium text-ink-fg'
                    : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4',
                  isDrop && 'mk-dropzone',
                  disabled && 'cursor-not-allowed opacity-45'
                )}
              >
                <span className="grid w-3.5 shrink-0 place-items-center text-ink-fg-3">
                  {node.hasChildren ? (
                    <span
                      role="presentation"
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggle(node.path)
                      }}
                    >
                      <CollapseChevron expanded={expanded.has(node.path)} size={11} />
                    </span>
                  ) : null}
                </span>
                <span className={cn('shrink-0', isSel ? 'text-coral' : 'text-ink-fg-2')}>
                  {node.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.unavailable ? (
                  <TriangleAlert
                    size={11}
                    strokeWidth={2}
                    className="shrink-0 text-warn"
                    aria-hidden
                  />
                ) : null}
                {node.readonly && !node.unavailable ? (
                  <Lock size={10} strokeWidth={2} className="shrink-0 text-ink-fg-3" aria-hidden />
                ) : null}
                {node.count > 0 ? (
                  <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
                    {node.count}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                ref={(el) => {
                  if (el) triggerRefs.current.set(node.path, el)
                }}
                aria-label={`${node.name} 的更多操作`}
                onClick={() => setMenuFor(node.path)}
                className={cn(
                  'absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded',
                  'text-ink-fg-3 opacity-0 transition-opacity duration-fast',
                  'hover:bg-ink-4 hover:text-ink-fg focus-visible:opacity-100 group-hover/row:opacity-100',
                  disabled && 'hidden'
                )}
              >
                <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
              </button>
              <Popmenu
                open={menuFor === node.path}
                onClose={() => setMenuFor(null)}
                ariaLabel={`${node.name} 菜单`}
                title={node.name}
                align="end"
                width={260}
                triggerRef={{ current: triggerRefs.current.get(node.path) ?? null }}
                items={nodeMenuItems(node, (what) => onNodeAction?.(node, what))}
              />
            </div>
          )
        })}

        <button
          type="button"
          onClick={onAddFolder}
          className="mt-2 flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-body text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <span className="grid w-3.5 shrink-0 place-items-center" />
          <Plus size={ICON_SIZE} strokeWidth={2} aria-hidden />
          <span className="flex-1 truncate">{S.addFolder}</span>
        </button>
      </div>
    </div>
  )
}
