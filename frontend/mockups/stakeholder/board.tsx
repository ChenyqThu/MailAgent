import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  pointerWithin, rectIntersection, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

export interface GroupOrder { id: string; itemIds: string[] }
export const GROUP_PREFIX = 'board:group:'
export const HEADER_PREFIX = 'board:header:'
export const groupDroppableId = (id: string) => `${GROUP_PREFIX}${id}`
export const headerDroppableId = (id: string) => `${HEADER_PREFIX}${id}`
const groupIdOfContainer = (raw: unknown) =>
  typeof raw === 'string' && raw.startsWith(GROUP_PREFIX) ? raw.slice(GROUP_PREFIX.length) : null
const groupIdOfHeader = (raw: unknown) =>
  typeof raw === 'string' && raw.startsWith(HEADER_PREFIX) ? raw.slice(HEADER_PREFIX.length) : null

export function sameOrder(a: readonly GroupOrder[], b: readonly GroupOrder[]): boolean {
  if (a.length !== b.length) return false
  return a.every((g, i) => g.id === b[i]!.id && g.itemIds.join() === b[i]!.itemIds.join())
}

export function applyDrag(groups: readonly GroupOrder[], ev: { active: { id: unknown }; over: { id: unknown } | null }): readonly GroupOrder[] {
  if (!ev.over) return groups
  const activeId = String(ev.active.id)
  const overId = ev.over.id
  if (String(overId) === activeId) return groups
  if (groupIdOfHeader(overId) != null) return groups
  const from = groups.find((g) => g.itemIds.includes(activeId))
  if (!from) return groups
  const containerGroupId = groupIdOfContainer(overId)
  const targetId = containerGroupId ?? groups.find((g) => g.itemIds.includes(String(overId)))?.id
  if (targetId == null) return groups

  const next = groups.map((g) => ({ id: g.id, itemIds: [...g.itemIds] }))
  const target = next.find((g) => g.id === targetId)!
  if (from.id === targetId && containerGroupId == null) {
    // 同组：arrayMove 语义（先删再找下标会差一位 ⇒ 拖了等于没拖）
    const f = target.itemIds.indexOf(activeId)
    const t = target.itemIds.indexOf(String(overId))
    if (f < 0 || t < 0) return groups
    target.itemIds.splice(f, 1)
    target.itemIds.splice(t, 0, activeId)
  } else {
    for (const g of next) g.itemIds = g.itemIds.filter((id) => id !== activeId)
    const idx = containerGroupId != null ? target.itemIds.length : target.itemIds.indexOf(String(overId))
    target.itemIds.splice(idx < 0 ? target.itemIds.length : idx, 0, activeId)
  }
  return sameOrder(next, groups) ? groups : next
}

/** 🔴 多容器必须 pointerWithin 优先：closestCenter 比的是「中心点距离」，
 *  空的/很扁的核心组永远抢不过旁边那张大卡 ⇒ 表现就是「拖过去没反应」。 */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

interface BoardProps<T> {
  groups: { id: string; items: T[]; collapsed?: boolean }[]
  getId(item: T): string
  onReorder(order: readonly GroupOrder[]): void
  onRequestExpand?(groupId: string): void
  /** true = 复现现状缺陷（落下即丢弃乐观顺序）。对照用。 */
  snapBackBug?: boolean
  renderItem(item: T, s: { dragging: boolean; handleProps: Record<string, unknown> }): React.ReactNode
  renderOverlay?(item: T): React.ReactNode
  renderGroup(a: { group: { id: string; items: T[]; collapsed?: boolean }; children: React.ReactNode; headerRef: (n: HTMLElement | null) => void; isOver: boolean }): React.ReactNode
  renderEmpty?(g: { id: string }, s: { isOver: boolean }): React.ReactNode
}

export function Board<T>({
  groups, getId, onReorder, onRequestExpand, snapBackBug = false,
  renderItem, renderOverlay, renderGroup, renderEmpty
}: BoardProps<T>): React.ReactElement {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<readonly GroupOrder[] | null>(null)
  const startedRef = useRef<readonly GroupOrder[] | null>(null)

  const itemById = useMemo(() => {
    const m = new Map<string, T>()
    for (const g of groups) for (const it of g.items) m.set(getId(it), it)
    return m
  }, [groups, getId])

  const propsOrder = useMemo<readonly GroupOrder[]>(
    () => groups.map((g) => ({ id: g.id, itemIds: g.items.map(getId) })), [groups, getId])
  const order = draft ?? propsOrder

  // ✅ 修复核心：落下后**保留**乐观顺序，直到 props 追上来才交还控制权。
  // 现状是落下即 setDraft(null) ⇒ 那一帧用的还是服务端旧顺序 ⇒ 卡片弹回原位，
  // 等 mutation 回来才跳到新位 = owner 看到的「先回去再突然换位」。
  useEffect(() => {
    if (draft == null || activeId != null) return
    if (sameOrder(propsOrder, draft)) setDraft(null)
  }, [propsOrder, draft, activeId])

  const viewGroups = useMemo(() => groups.map((g) => {
    const o = order.find((e) => e.id === g.id)
    if (!o) return g
    return { ...g, items: o.itemIds.map((id) => itemById.get(id)).filter((x): x is T => x !== undefined) }
  }), [groups, order, itemById])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragStart = (e: DragStartEvent) => {
    startedRef.current = propsOrder
    setActiveId(String(e.active.id))
    setDraft(propsOrder)
  }
  const onDragOver = (e: DragOverEvent) => {
    const expand = e.over == null ? null : groupIdOfHeader(e.over.id)
    if (expand != null) { onRequestExpand?.(expand); return }
    setDraft(applyDrag(draft ?? propsOrder, e))
  }
  const finish = (next: readonly GroupOrder[] | null) => {
    setActiveId(null)
    const started = startedRef.current
    startedRef.current = null
    if (next && started && !sameOrder(next, started)) {
      if (snapBackBug) setDraft(null)   // ← 现状：立刻丢弃 ⇒ 回弹
      else setDraft(next)               // ← 修复：留着，等 props 追上
      onReorder(next)
    } else setDraft(null)
  }

  const activeItem = activeId == null ? null : (itemById.get(activeId) ?? null)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={(e: DragEndEvent) => finish(applyDrag(draft ?? propsOrder, e))}
      onDragCancel={() => finish(null)}
    >
      {viewGroups.map((g) => (
        <Group key={g.id} group={g} getId={getId} activeId={activeId}
          renderItem={renderItem} renderGroup={renderGroup} renderEmpty={renderEmpty} />
      ))}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }}>
        {activeItem ? (renderOverlay ?? ((i: T) => renderItem(i, { dragging: true, handleProps: {} })))(activeItem) : null}
      </DragOverlay>
    </DndContext>
  )
}

function Group<T>({ group, getId, activeId, renderItem, renderGroup, renderEmpty }: any): React.ReactElement {
  const container = useDroppable({ id: groupDroppableId(group.id) })
  const header = useDroppable({ id: headerDroppableId(group.id), disabled: !group.collapsed })
  const itemIds = group.items.map(getId)
  const body = group.collapsed ? null : (
    <div ref={container.setNodeRef}>
      <SortableContext items={itemIds} strategy={rectSortingStrategy}>
        {group.items.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] items-stretch gap-2.5">
            {group.items.map((it: T) => (
              <Card key={getId(it)} id={getId(it)} item={it} dragging={getId(it) === activeId} renderItem={renderItem} />
            ))}
          </div>
        ) : (renderEmpty?.(group, { isOver: container.isOver }) ?? <div className="min-h-[2.5rem]" />)}
      </SortableContext>
    </div>
  )
  return <>{renderGroup({ group, children: body, headerRef: header.setNodeRef, isOver: container.isOver || header.isOver })}</>
}

function Card<T>({ id, item, dragging, renderItem }: any): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'z-10' : undefined}>
      {renderItem(item, { dragging, handleProps: { ...attributes, ...listeners } })}
    </div>
  )
}
