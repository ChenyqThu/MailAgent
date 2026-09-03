// 收编自 beui.dev `motion/file-tree.tsx`（MIT，许可原文见同目录 `LICENSE-beui`）。
// 登记见 `docs/motion-gsap.md`「beui 收编组件登记表」。
//
// 相对上游改了三处（design §2.2 点名的那三处）：
//   ① **JSX children → 数据递归**：上游用 `<FileTreeFolder>` / `<FileTreeFile>` 两个
//      「渲染 null、只供 Children 读 props」的声明式壳；我们的树来自 API，所以直接吃
//      `nodes` 数组，摊平逻辑（depth / parentId / posinset / setsize）照抄上游。
//   ② pill 的两处 `filter: blur(6px)` 在 `SharedLayoutBg` 里剥掉了（DESIGN §8）；
//      这里把它从 hover 驱动改成**选中**驱动（`activeIndex`），即 design §2.2 的
//      「选中 pill `layoutId` + `SPRING_LAYOUT`」。
//   ③ 曲线 / spring 单源 `@shared/lib/motion-tokens`（上游 `@/lib/ease`，值逐字相同），
//      折叠标识改用全仓单源 `ui/collapsible` 的 `CollapseChevron`。
//
// 另外两处刻意的取舍：
//   · **不画分支连线**：上游每行画一段 `w-px` 竖线拼成连线，评审通过的原型
//     （`mockups/library`）是纯缩进无连线，原型是权威。
//   · **超阈值退化成 `react-window`**：design §2.2 —— 单文件夹超过
//     `TREE_VIRTUALIZE_THRESHOLD` 就换虚拟列表，并**放弃 layoutId pill**（虚拟化会
//     回收滚出视口的行，pill 在两个「同时在 DOM 里」的行之间做位移的前提就没了）。
//     退化档里选中态回落成行自身的 `.acc-select` 底色，位置瞬切。
//
// 🔴 展开折叠没有用 `CollapsibleRegion`（design §2.2 提到它）：那是 grid-rows
//    `0fr↔1fr` 的**嵌套** DOM 原语，而本组件是摊平单列（keyboard treeview 语义与上面
//    那条虚拟化退化都建立在摊平之上），两者结构互斥。折叠位移改由上游那套
//    `layout="position"` + 行进退场承担，reduced-motion 下整段 no-op。

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { File, Folder, FolderOpen } from 'lucide-react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'

import { CollapseChevron } from '@shared/components/ui/collapsible'
import { SharedLayoutBg } from '@shared/components/ui/SharedLayoutBg'
import { cn } from '@shared/lib/cn'
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from '@shared/lib/motion-tokens'

export interface FileTreeNode {
  /** 稳定身份（资料库用虚拟路径）。同一棵树内唯一。 */
  value: string
  name: string
  type: 'file' | 'folder'
  children?: readonly FileTreeNode[]
  /** 不传就用默认的 文件 / 文件夹(开合) 图标。 */
  icon?: ReactNode
  /** 行尾槽位：角标 / 锁 / 警示 / 「更多」按钮都走这里，呈现层不解释语义。 */
  trailing?: ReactNode
  /** 不可点也不可展开（例如卷被拔掉的挂载根）。 */
  disabled?: boolean
  /** 可点但灰显（`status='missing'` 的行、iCloud 未下载的占位文件）。 */
  muted?: boolean
  className?: string
}

export type FileTreeClassNames = {
  tree?: string
  item?: string
  icon?: string
  label?: string
}

export interface FileTreeProps {
  nodes: readonly FileTreeNode[]
  value?: string | null
  defaultValue?: string | null
  onValueChange?: (value: string) => void
  expandedIds?: readonly string[]
  defaultExpandedIds?: readonly string[]
  onExpandedChange?: (expandedIds: string[]) => void
  ariaLabel?: string
  /** 每一层的缩进（px）。 */
  indent?: number
  /** 摊平后的行数超过它就退化成虚拟列表并放弃 pill。 */
  virtualizeThreshold?: number
  /** 退化档的定高行高（px），与非退化档的行高保持一致。 */
  rowHeight?: number
  /** pill 的类名覆盖（默认 = 全仓选中配方：`.acc-select` 底色 + `.row-selected` 左光条）。 */
  pillClassName?: string
  className?: string
  classNames?: FileTreeClassNames
}

interface FlatRow {
  node: FileTreeNode
  depth: number
  parentId: string | null
  position: number
  setSize: number
}

const ROW_ENTER = { duration: 0.22, ease: EASE_OUT } as const
/** 行多了 stagger 只会让最后一行等半秒（docs/motion-gsap.md §1）。 */
const STAGGER_MAX_ROWS = 30
const DEFAULT_ROW_HEIGHT = 30
const DEFAULT_INDENT = 14

function flattenNodes(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null
): FlatRow[] {
  return nodes.flatMap((node, index) => {
    const row: FlatRow = { node, depth, parentId, position: index + 1, setSize: nodes.length }
    if (node.type !== 'folder' || !expanded.has(node.value) || !node.children?.length) return [row]
    return [row, ...flattenNodes(node.children, expanded, depth + 1, node.value)]
  })
}

function DefaultIcon({
  node,
  open,
  reduce
}: {
  node: FileTreeNode
  open: boolean
  reduce: boolean
}): ReactElement {
  if (node.type === 'file') return <File className="size-3.5" strokeWidth={1.9} />
  if (reduce) {
    return open ? (
      <FolderOpen className="size-3.5" strokeWidth={1.9} />
    ) : (
      <Folder className="size-3.5" strokeWidth={1.9} />
    )
  }
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={open ? 'open' : 'closed'}
        initial={{ opacity: 0, scale: 0.75, rotate: open ? -8 : 8 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={{ opacity: 0, scale: 0.75, rotate: open ? 8 : -8 }}
        transition={SPRING_SWAP}
        className="absolute inset-0 grid place-items-center"
      >
        {open ? (
          <FolderOpen className="size-3.5" strokeWidth={1.9} />
        ) : (
          <Folder className="size-3.5" strokeWidth={1.9} />
        )}
      </motion.span>
    </AnimatePresence>
  )
}

/** 一行的可视内容 —— 非退化档与虚拟化档共用，免得两条分支各画一遍行。 */
function FileTreeRow(props: {
  row: FlatRow
  isOpen: boolean
  isSelected: boolean
  focused: boolean
  indent: number
  reduce: boolean
  rowHeight: number
  classNames?: FileTreeClassNames
  /** 退化档没有 pill，选中态回落到行自身的底色。 */
  selectedWash: boolean
  registerRef: (value: string, node: HTMLButtonElement | null) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onClick: () => void
}): ReactElement {
  const { row, isOpen, isSelected, classNames } = props
  const { node } = row
  return (
    <button
      ref={(el) => props.registerRef(node.value, el)}
      type="button"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.setSize}
      aria-selected={isSelected}
      aria-expanded={node.type === 'folder' ? isOpen : undefined}
      aria-disabled={node.disabled || undefined}
      tabIndex={props.focused ? 0 : -1}
      onFocus={props.onFocus}
      onKeyDown={props.onKeyDown}
      onClick={props.onClick}
      style={{ paddingLeft: 8 + row.depth * props.indent, height: props.rowHeight }}
      className={cn(
        'row group/file-tree relative flex w-full items-center gap-2 overflow-hidden pr-2',
        'rounded-[var(--r-ctl)] text-left text-body outline-none transition-colors duration-fast',
        'focus-visible:ring-2 focus-visible:ring-coral/70',
        isSelected ? 'font-medium text-ink-fg' : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg',
        props.selectedWash && isSelected && 'row-selected acc-select',
        node.disabled && 'cursor-not-allowed opacity-45',
        node.muted && !node.disabled && 'opacity-55',
        classNames?.item,
        node.className
      )}
    >
      <span className="relative z-10 grid w-3.5 shrink-0 place-items-center text-ink-fg-3">
        {node.type === 'folder' && node.children?.length ? (
          <CollapseChevron expanded={isOpen} size={11} />
        ) : null}
      </span>

      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 grid size-4 shrink-0 place-items-center transition-colors',
          isSelected ? 'text-coral' : 'text-ink-fg-2 group-hover/file-tree:text-ink-fg',
          classNames?.icon
        )}
      >
        {node.icon ?? <DefaultIcon node={node} open={isOpen} reduce={props.reduce} />}
      </span>

      <span className={cn('relative z-10 min-w-0 flex-1 truncate', classNames?.label)}>
        {node.name}
      </span>

      {node.trailing != null ? (
        <span className="relative z-10 shrink-0 text-micro text-ink-fg-3">{node.trailing}</span>
      ) : null}
    </button>
  )
}

type VirtualRowProps = {
  rows: readonly FlatRow[]
  selectedId: string | null
  focusedRow: string | null
  expanded: ReadonlySet<string>
  indent: number
  reduce: boolean
  rowHeight: number
  classNames?: FileTreeClassNames
  registerRef: (value: string, node: HTMLButtonElement | null) => void
  onFocus: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, row: FlatRow) => void
  onActivate: (row: FlatRow) => void
}

function VirtualRow({
  index,
  style,
  rows,
  selectedId,
  focusedRow,
  expanded,
  indent,
  reduce,
  rowHeight,
  classNames,
  registerRef,
  onFocus,
  onKeyDown,
  onActivate
}: RowComponentProps<VirtualRowProps>): ReactElement {
  const row = rows[index]
  return (
    <div style={style} className="px-0">
      <FileTreeRow
        row={row}
        isOpen={row.node.type === 'folder' && expanded.has(row.node.value)}
        isSelected={selectedId === row.node.value}
        focused={focusedRow === row.node.value}
        indent={indent}
        reduce={reduce}
        rowHeight={rowHeight}
        classNames={classNames}
        selectedWash
        registerRef={registerRef}
        onFocus={() => onFocus(row.node.value)}
        onKeyDown={(event) => onKeyDown(event, row)}
        onClick={() => onActivate(row)}
      />
    </div>
  )
}

export function FileTree({
  nodes,
  value,
  defaultValue = null,
  onValueChange,
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  ariaLabel = 'Files',
  indent = DEFAULT_INDENT,
  virtualizeThreshold = 500,
  rowHeight = DEFAULT_ROW_HEIGHT,
  pillClassName,
  className,
  classNames
}: FileTreeProps): ReactElement {
  const reduce = useReducedMotion() ?? false
  const [internalValue, setInternalValue] = useState(defaultValue)
  const [internalExpandedIds, setInternalExpandedIds] = useState<readonly string[]>(
    defaultExpandedIds ?? []
  )
  const [focusedId, setFocusedId] = useState<string | null>(value ?? defaultValue)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const listRef = useRef<ListImperativeAPI | null>(null)

  const selectedId = value === undefined ? internalValue : value
  const currentExpandedIds = expandedIds ?? internalExpandedIds
  const expanded = useMemo(() => new Set(currentExpandedIds), [currentExpandedIds])
  const rows = useMemo(() => flattenNodes(nodes, expanded), [expanded, nodes])
  const virtualized = rows.length > virtualizeThreshold

  // 焦点行恒指向一个真行：首帧、以及折叠把原焦点行从树上摘掉之后。
  const focusedRow =
    focusedId !== null && rows.some(({ node }) => node.value === focusedId)
      ? focusedId
      : (rows[0]?.node.value ?? null)
  if (focusedId !== focusedRow) setFocusedId(focusedRow)

  const registerRef = useCallback((key: string, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(key, node)
    else rowRefs.current.delete(key)
  }, [])

  const focusRow = useCallback(
    (id: string) => {
      setFocusedId(id)
      const existing = rowRefs.current.get(id)
      if (existing) {
        existing.focus()
        return
      }
      // 退化档：目标行可能还没进 DOM，先滚过去再等一帧抓它。
      if (virtualized) {
        const index = rows.findIndex(({ node }) => node.value === id)
        if (index >= 0) listRef.current?.scrollToRow({ index, align: 'auto' })
      }
      requestAnimationFrame(() => rowRefs.current.get(id)?.focus())
    },
    [rows, virtualized]
  )

  const selectNode = useCallback(
    (node: FileTreeNode) => {
      if (node.disabled) return
      if (value === undefined) setInternalValue(node.value)
      onValueChange?.(node.value)
    },
    [onValueChange, value]
  )

  const setExpanded = useCallback(
    (next: string[]) => {
      if (expandedIds === undefined) setInternalExpandedIds(next)
      onExpandedChange?.(next)
    },
    [expandedIds, onExpandedChange]
  )

  const toggleFolder = useCallback(
    (id: string) => {
      const next = new Set(currentExpandedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setExpanded(Array.from(next))
    },
    [currentExpandedIds, setExpanded]
  )

  const activateRow = useCallback(
    (row: FlatRow) => {
      if (row.node.disabled) return
      selectNode(row.node)
      if (row.node.type === 'folder') toggleFolder(row.node.value)
    },
    [selectNode, toggleFolder]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, row: FlatRow) => {
      const index = rows.findIndex(({ node }) => node.value === row.node.value)
      const previous = rows[index - 1]
      const next = rows[index + 1]
      const isFolder = row.node.type === 'folder'
      const isOpen = expanded.has(row.node.value)

      if (event.key === 'ArrowDown' && next) {
        event.preventDefault()
        focusRow(next.node.value)
      } else if (event.key === 'ArrowUp' && previous) {
        event.preventDefault()
        focusRow(previous.node.value)
      } else if (event.key === 'Home' && rows[0]) {
        event.preventDefault()
        focusRow(rows[0].node.value)
      } else if (event.key === 'End' && rows.at(-1)) {
        event.preventDefault()
        focusRow(rows.at(-1)?.node.value ?? row.node.value)
      } else if (event.key === 'ArrowRight' && isFolder) {
        event.preventDefault()
        if (!isOpen && !row.node.disabled) toggleFolder(row.node.value)
        else if (next?.parentId === row.node.value) focusRow(next.node.value)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (isFolder && isOpen && !row.node.disabled) toggleFolder(row.node.value)
        else if (row.parentId) focusRow(row.parentId)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        activateRow(row)
      }
    },
    [activateRow, expanded, focusRow, rows, toggleFolder]
  )

  if (virtualized) {
    return (
      <div
        role="tree"
        aria-label={ariaLabel}
        aria-multiselectable="false"
        data-virtualized="true"
        className={cn('min-w-0 h-full', className, classNames?.tree)}
      >
        <List<VirtualRowProps>
          listRef={listRef}
          rowComponent={VirtualRow}
          rowCount={rows.length}
          rowHeight={rowHeight}
          // 量到真实高度之前的回落视口（happy-dom 无 ResizeObserver，测试也吃这个值）。
          defaultHeight={600}
          rowProps={{
            rows,
            selectedId,
            focusedRow,
            expanded,
            indent,
            reduce,
            rowHeight,
            classNames,
            registerRef,
            onFocus: setFocusedId,
            onKeyDown: handleKeyDown,
            onActivate: activateRow
          }}
          className="scrollbar-thin"
          style={{ height: '100%' }}
        />
      </div>
    )
  }

  const stagger = rows.length < STAGGER_MAX_ROWS
  const selectedIndex = rows.findIndex(({ node }) => node.value === selectedId)

  return (
    <SharedLayoutBg
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="false"
      data-virtualized="false"
      inset={0}
      activeIndex={selectedIndex >= 0 ? selectedIndex : null}
      pillClassName={pillClassName ?? 'acc-select row-selected rounded-[var(--r-ctl)]'}
      className={cn('min-w-0', className, classNames?.tree)}
    >
      {rows.map((row) => (
        <motion.div
          layout={reduce ? false : 'position'}
          key={row.node.value}
          initial={reduce ? false : { opacity: 0, y: -6 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: reduce
              ? { duration: 0 }
              : { ...ROW_ENTER, delay: stagger ? Math.min(row.position * 0.025, 0.1) : 0 }
          }}
          transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        >
          <FileTreeRow
            row={row}
            isOpen={row.node.type === 'folder' && expanded.has(row.node.value)}
            isSelected={selectedId === row.node.value}
            focused={focusedRow === row.node.value}
            indent={indent}
            reduce={reduce}
            rowHeight={rowHeight}
            classNames={classNames}
            selectedWash={false}
            registerRef={registerRef}
            onFocus={() => setFocusedId(row.node.value)}
            onKeyDown={(event) => handleKeyDown(event, row)}
            onClick={() => activateRow(row)}
          />
        </motion.div>
      ))}
    </SharedLayoutBg>
  )
}
