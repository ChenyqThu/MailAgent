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
// **卡片长什么样、组标题长什么样、grid 几列，全由调用方渲染**。两块最容易出错、也最难
// 靠渲染测试摸到的逻辑各自单独成文并直测：落位算法在 `boardOrder.ts`，命中判定在
// `boardCollision.ts`（为什么不能用 closestCenter 见那里）。
//
// 折叠组：给某组传 `collapsed`，它的标题就成为一个 droppable —— 拖着卡悬上去会触发
// `onRequestExpand`，调用方展开后即可拖进组内定位。数据不会因为悬停而变。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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

import { boardCollisionDetection } from './boardCollision'
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
  /** 乐观顺序变了 —— 拖拽进行中每次落点变化都会调，落下后**继续持有**那份顺序
   *  （见下方 `finish`），直到 props 追上或写入失败才回 null。 */
  onDraftChange?(order: SortableBoardOrder | null): void
  /**
   * 写入失败的信号：**每次** `onReorder` 提交失败就把这个数递增（值本身无意义，
   * 只看「变没变」）。收到变化即丢弃乐观顺序、回落到 props。
   *
   * 🔴 必须接：落下后本组件持有乐观顺序等 props 追上来，而写失败时 props 永远追不上
   * ⇒ 不给这个信号，UI 会一直显示一个后端并不存在的顺序（刷新才自愈）。
   * 🔴 不要拿定时器兜底 —— 那只是把「一直错」变成「错几秒」，根因还在。
   */
  commitFailedAt?: number
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
  commitFailedAt,
  onRequestExpand,
  renderItem,
  renderOverlay,
  renderGroup,
  gridClassName = DEFAULT_GRID,
  renderEmpty,
  announcements
}: SortableBoardProps<T>): React.ReactElement {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 乐观顺序；null = 用 props 那份。落下后**不清空**（见 `finish`）。 */
  const [draft, setDraft] = useState<SortableBoardOrder | null>(null)
  const startedRef = useRef<SortableBoardOrder | null>(null)
  const lastFailureRef = useRef(commitFailedAt)

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

  // 交还控制权：props 追上乐观顺序了，draft 就没用了。
  //
  // 🔴 这个 effect 是「落下先弹回原位、几百毫秒后才跳到新位」的解药的**另一半**。
  // 落下那一刻清 draft（原实现）⇒ 那一帧渲染的还是服务端旧顺序 ⇒ 卡片弹回去，等
  // mutation 回来才跳到新位。所以 `finish` 保留 draft，由这里在 props 真的变成新
  // 顺序之后才放手 —— 中间没有任何一帧是旧顺序。
  useEffect(() => {
    if (draft == null || activeId != null) return
    if (!sameBoardOrder(propsOrder, draft)) return
    setDraft(null)
    onDraftChange?.(null)
  }, [propsOrder, draft, activeId, onDraftChange])

  // 写入失败 ⇒ 回滚。props 永远追不上时上面那个 effect 不会触发，只能靠调用方给信号。
  useEffect(() => {
    if (commitFailedAt === lastFailureRef.current) return
    lastFailureRef.current = commitFailedAt
    setDraft(null)
    onDraftChange?.(null)
  }, [commitFailedAt, onDraftChange])

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
    const started = startedRef.current
    startedRef.current = null
    if (next && started && !sameBoardOrder(next, started)) {
      // 🔴 **保留**乐观顺序，别在这里 `pushDraft(null)`：props 要等 mutation 回来才更新，
      // 清掉的那一帧渲染的是服务端旧顺序 = 卡片当场弹回原位。交还控制权的时机在上面
      // 那个 effect（props 追上）与失败回滚 effect（写挂了）。
      pushDraft(next)
      onReorder(next)
    } else {
      // 拖起又放回原位 / 取消：没有待落地的写入，直接还给 props。
      pushDraft(null)
    }
  }

  const activeItem = activeId == null ? null : (itemById.get(activeId) ?? null)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
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
      {/* 落下的收尾动画。默认 250ms 偏拖沓；180ms + decelerate 曲线是 mockup 验收过的手感。
          它把 overlay 收回**卡当前所在的格子** —— 乐观顺序保留住了，那个格子就是新位置。 */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
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
