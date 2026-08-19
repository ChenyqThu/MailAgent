// SortableBoard —— 全 app **二维 grid + 跨组**拖拽基座（dnd-kit）。
//
// 与 `DragReorderList` 的分工（两个都留着，不要合并）：
//   DragReorderList —— 一维**单列表**重排。移植自 lab.moumen.dev，手感（RAW 跟手 /
//     兄弟行 glide / 落下 FLIP / rubber-band）是它的全部价值，owner 验收过。侧边栏
//     文件夹排序在用。它结构上没有二维命中，也没有跨容器概念。
//   SortableBoard（本文件）—— **grid 布局**里的重排，以及**多组之间**的搬运。
//     干系人「核心 / 其他」在用；未来 dashboard / 看板列也走这里。
//
// 为什么是 dnd-kit 而不是自研：二维命中 + 多容器 + 键盘可达 + 屏幕阅读器播报，自己写
// 一套正是 `Popmenu.tsx:5-8` 记着的那条教训（「凭印象重写，owner dogfood 判交互质感
// 一坨屎」）。dnd-kit 是这块的事实标准。
//
// 本组件是 **headless-ish** 的：拖拽机制（sensors / 落位 / overlay / a11y 播报）在这里，
// **卡片长什么样、组标题长什么样、grid 几列，全由调用方渲染**。落位算法单独在
// `boardOrder.ts` 并直测。
//
// 折叠组：给某组传 `collapsed`，它的标题就成为一个 droppable —— 拖着卡悬上去会触发
// `onRequestExpand`，调用方展开后即可拖进组内定位。数据不会因为悬停而变。

import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { cn } from '@shared/lib/cn'

import {
  applyBoardDrag,
  groupDroppableId,
  groupIdOfHeader,
  headerDroppableId,
  sameBoardOrder,
  type BoardGroupOrder
} from './boardOrder'

/** 一组的输入：id + 有序 items + 可选的折叠态。 */
export interface SortableBoardGroup<T> {
  id: string
  items: readonly T[]
  /** 收起：本组不渲染 items，其标题成为「悬停即展开」的落点。 */
  collapsed?: boolean
}

/** 落位结果：每组的 id 顺序。调用方据此重建自己的数据并提交。 */
export type SortableBoardOrder = readonly BoardGroupOrder[]

export interface SortableBoardProps<T> {
  groups: readonly SortableBoardGroup<T>[]
  getItemId(item: T): string
  /** 拖拽**落下**时的最终顺序。与拖起前一致时不会调用（拖起又放回是常态）。 */
  onReorder(order: SortableBoardOrder): void
  /** 拖拽**进行中**的乐观顺序 —— 给了它，跨组时卡会立刻出现在新组里。 */
  onDraftChange?(order: SortableBoardOrder | null): void
  /** 悬停在某个折叠组的标题上（调用方负责展开）。 */
  onRequestExpand?(groupId: string): void
  /** `handleProps` 必须挂到一个起拖控件上（通常是一颗 grip 按钮）—— 不挂就拖不动。
   *  它同时是**键盘拖拽**的入口（dnd-kit 的 KeyboardSensor 读 attributes）。 */
  renderItem(item: T, state: { dragging: boolean; handleProps: Record<string, unknown> }): ReactNode
  /** 拖拽中跟着指针的那张。不给则复用 renderItem。 */
  renderOverlay?(item: T): ReactNode
  /** 组的外壳（标题 / 空态 / 计数由调用方决定）。`children` 是该组的 grid。 */
  renderGroup(args: {
    group: SortableBoardGroup<T>
    children: ReactNode
    /** 折叠组的标题必须挂它，否则「拖上去展开」没有落点。 */
    headerRef: (node: HTMLElement | null) => void
    /** 指针当前是否悬在本组（含其标题）上 —— 用来给落点加高亮。 */
    isOver: boolean
  }): ReactNode
  /** grid 容器的类名。默认 `repeat(auto-fill,minmax(240px,1fr))`。 */
  gridClassName?: string
  /** 空组的占位（必须渲染点什么，否则空组没有可命中的面积）。 */
  renderEmpty?(group: SortableBoardGroup<T>, state: { isOver: boolean }): ReactNode
  announcements?: Announcements
}

const DEFAULT_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2'

export function SortableBoard<T>({
  groups,
  getItemId,
  onReorder,
  onDraftChange,
  onRequestExpand,
  renderItem,
  renderOverlay,
  renderGroup,
  gridClassName = DEFAULT_GRID,
  renderEmpty,
  announcements
}: SortableBoardProps<T>): React.ReactElement {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 拖拽期间的乐观顺序；null = 用 props 那份。 */
  const [draft, setDraft] = useState<SortableBoardOrder | null>(null)
  const startedRef = useRef<SortableBoardOrder | null>(null)

  const itemById = useMemo(() => {
    const index = new Map<string, T>()
    for (const group of groups) for (const item of group.items) index.set(getItemId(item), item)
    return index
  }, [groups, getItemId])

  const propsOrder = useMemo<SortableBoardOrder>(
    () => groups.map((group) => ({ id: group.id, itemIds: group.items.map(getItemId) })),
    [groups, getItemId]
  )
  const order = draft ?? propsOrder

  // 渲染用的分组：拖拽期间按 draft 重排，非拖拽期间就是 props。
  const viewGroups = useMemo(
    () =>
      groups.map((group) => {
        const ordered = order.find((entry) => entry.id === group.id)
        if (!ordered) return group
        const items = ordered.itemIds
          .map((id) => itemById.get(id))
          .filter((item): item is T => item !== undefined)
        return { ...group, items }
      }),
    [groups, order, itemById]
  )

  const sensors = useSensors(
    // 8px 起拖：卡上通常还有按钮，零距离起拖会把点击吃掉。
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const pushDraft = (next: SortableBoardOrder | null): void => {
    setDraft(next)
    onDraftChange?.(next)
  }

  const onDragStart = (event: DragStartEvent): void => {
    startedRef.current = propsOrder
    setActiveId(String(event.active.id))
    pushDraft(propsOrder)
  }

  const onDragOver = (event: DragOverEvent): void => {
    const expandTarget = event.over == null ? null : groupIdOfHeader(event.over.id)
    if (expandTarget != null) {
      onRequestExpand?.(expandTarget)
      return
    }
    pushDraft(applyBoardDrag(draft ?? propsOrder, event))
  }

  const finish = (next: SortableBoardOrder | null): void => {
    setActiveId(null)
    pushDraft(null)
    const started = startedRef.current
    startedRef.current = null
    if (next && started && !sameBoardOrder(next, started)) onReorder(next)
  }

  const activeItem = activeId == null ? null : (itemById.get(activeId) ?? null)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={(event: DragEndEvent) => finish(applyBoardDrag(draft ?? propsOrder, event))}
      onDragCancel={() => finish(null)}
      accessibility={announcements ? { announcements } : undefined}
    >
      {viewGroups.map((group) => (
        <BoardGroup
          key={group.id}
          group={group}
          getItemId={getItemId}
          activeId={activeId}
          renderItem={renderItem}
          renderGroup={renderGroup}
          renderEmpty={renderEmpty}
          gridClassName={gridClassName}
        />
      ))}
      <DragOverlay>
        {activeItem
          ? (renderOverlay ?? ((item: T) => renderItem(item, { dragging: true, handleProps: {} })))(
              activeItem
            )
          : null}
      </DragOverlay>
    </DndContext>
  )
}

function BoardGroup<T>({
  group,
  getItemId,
  activeId,
  renderItem,
  renderGroup,
  renderEmpty,
  gridClassName
}: {
  group: SortableBoardGroup<T>
  getItemId(item: T): string
  activeId: string | null
  renderItem: SortableBoardProps<T>['renderItem']
  renderGroup: SortableBoardProps<T>['renderGroup']
  renderEmpty: SortableBoardProps<T>['renderEmpty']
  gridClassName: string
}): React.ReactElement {
  // 组容器：空组也是落点 —— 否则「把最后一个 item 拖出去后再也拖不回来」。
  const container = useDroppable({ id: groupDroppableId(group.id) })
  // 折叠标题：只在收起时启用（展开后组容器自己就是落点，标题再抢命中会让拖回去变难）。
  const header = useDroppable({ id: headerDroppableId(group.id), disabled: !group.collapsed })
  const itemIds = group.items.map(getItemId)

  const body = group.collapsed ? null : (
    <div ref={container.setNodeRef}>
      <SortableContext items={itemIds} strategy={rectSortingStrategy}>
        {group.items.length > 0 ? (
          <div className={gridClassName}>
            {group.items.map((item) => (
              <SortableCard
                key={getItemId(item)}
                id={getItemId(item)}
                item={item}
                dragging={getItemId(item) === activeId}
                renderItem={renderItem}
              />
            ))}
          </div>
        ) : (
          (renderEmpty?.(group, { isOver: container.isOver }) ?? <div className="min-h-[2.5rem]" />)
        )}
      </SortableContext>
    </div>
  )

  return (
    <>
      {renderGroup({
        group,
        children: body,
        headerRef: header.setNodeRef,
        isOver: container.isOver || header.isOver
      })}
    </>
  )
}

function SortableCard<T>({
  id,
  item,
  dragging,
  renderItem
}: {
  id: string
  item: T
  dragging: boolean
  renderItem: SortableBoardProps<T>['renderItem']
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'z-10')}
    >
      {/* 🔴 起拖点交给调用方（把 `handleProps` 挂到一颗 grip 上），**不**把 listeners 铺在
          整张卡：整卡可拖会把卡内按钮的点击和文本选择一起吃掉。 */}
      {renderItem(item, { dragging, handleProps: { ...attributes, ...listeners } })}
    </div>
  )
}
