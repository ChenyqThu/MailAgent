// DragReorderList —— 全 app 垂直列表拖拽重排基座（FLIP + 键盘 + a11y）。
//
// 来源：lab.moumen.dev 的 `drag-to-reorder-list`，源码取自它的 shadcn registry
// （`https://lab.moumen.dev/r/drag-to-reorder-list.json`，registry item 里带完整
// TSX；底稿存 `.trellis/tasks/08-18-custom-folder-ordering-sidebar/research/`）。
// **这是照搬移植，不是复刻**（Popmenu 同款纪律）：三套 motion 系统的写通道、
// 时序、缓动常量、rubber-band 阻尼、键盘路径全部保留原实现。
//
// 原实现的核心（也是手感的来源，改动前先读懂）：
//   1. 被拖的行 RAW 跟指针 —— 它的 y motion value 在 pointermove 里直接
//      `jump()`（零 easing：手和卡之间任何缓动都读成延迟；热路径零 React render）。
//   2. 兄弟行让位 glide：被拖行跨过 slot 边界时，每个被位移的兄弟行 `animate()`
//      恰好一个 slot —— 可中途重定向，反向拖回去自然复位。
//   3. 落下是 FLIP：commit 前抓 First rects，让 React reflow，再把每行 Invert
//      回旧屏幕像素、`animate()` 回家。没有任何跳变。
//   外加越界 rubber-band（4:1 阻尼）、pointer capture、多点触控保护、完整键盘
//   路径（grip 聚焦 → Space/Enter 抓起 → ↑↓ 移动 → Esc 取消回原位）+ aria-live
//   播报，`useReducedMotion` 时全部硬切（`flip=false` 同效）。
//
// 与原实现的差异仅四类（交互内核零改动）：
//   结构：删 `"use client"`（Next 指令）/ demo 数据 DEFAULT_ITEMS（`defaultItems`
//         默认 []）/ `inspect` 教学调试覆盖层（连带只有它消费的 slot 指示
//         motion value 与 slotHeights 测量）/ demo 容器 `max-w-80`（宽度交给
//         消费方 `className`）；default export → 具名 export + `cn()` 合并
//         className（本仓约定），显式返回类型（TS strict）。
//   文案：aria 标签与 aria-live 播报全部经 `messages` prop 注入（默认英文 =
//         原实现逐字），消费方传 i18n `t()` 文案。
//   颜色：类名（bg-card / text-foreground / hover:bg-accent / outline-ring /
//         aria-pressed:bg-primary …）在本仓 tailwind 的 shadcn 别名下已映到
//         ink/coral token，原样保留即自动双主题（Popmenu 同款）。
//   阴影：原实现把 boxShadow 写在 motion `animate()` 内联值里（黑色 rgba，亮色
//         调的值暗色下等于没有）——改为 index.css 的 `.reorder-card[-lifted]`
//         CSS 变量档 + 同时长同曲线的 box-shadow transition；scale 仍由 motion
//         `animate()`（lifted 1.02 / rest 1，LIFT 时序不变）。
//
// a11y：role=list + 每行 grip button（aria-pressed 抓起态），aria-live=polite
// 播报抓起/移动/放下/取消；Esc 在指针拖拽与键盘抓起两条路径都可取消。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MotionConfig,
  animate,
  motion,
  useReducedMotion,
  type MotionValue,
  motionValue
} from 'motion/react'

import { cn } from '@shared/lib/cn'

const DRAG_THRESHOLD = 4
const EASE = [0.22, 1, 0.36, 1] as const
const MOVE = { duration: 0.2, ease: EASE } as const
const LIFT = { duration: 0.16, ease: EASE } as const

export interface ReorderItem {
  id: string
  label: string
  meta?: string
}

export interface ReorderState {
  order: string[]
  dragging: string | null
  from: number | null
  to: number | null
  grabbed: boolean
  lastMove: { label: string; from: number; to: number } | null
}

/** aria 标签 / aria-live 播报文案 —— 默认英文（原实现逐字），消费方用 t() 注入。 */
export interface ReorderMessages {
  /** 列表 aria-label。 */
  listLabel: string
  /** grip 按钮 aria-label。 */
  grip: (label: string, pos: number, count: number, grabbed: boolean) => string
  grabbed: (label: string, pos: number, count: number) => string
  dropped: (label: string, pos: number, count: number) => string
  moved: (label: string, pos: number, count: number) => string
  cancelled: (label: string) => string
}

const DEFAULT_MESSAGES: ReorderMessages = {
  listLabel: 'Reorderable list',
  grip: (label, pos, count, grabbed) =>
    `Reorder ${label}, position ${pos} of ${count}${grabbed ? ', grabbed' : ''}`,
  grabbed: (label, pos, count) =>
    `${label} grabbed at position ${pos} of ${count}. Use arrow keys to move, Space to drop, Escape to cancel.`,
  dropped: (label, pos, count) => `${label} dropped at position ${pos} of ${count}.`,
  moved: (label, pos, count) => `${label} moved to position ${pos} of ${count}.`,
  cancelled: (label) => `Reorder cancelled. ${label} is back at its original position.`
}

interface DragData {
  row: HTMLLIElement
  pointerId: number
  index: number
  startY: number
  active: boolean
  slot: number
  to: number
  rows?: HTMLLIElement[]
}

export function DragReorderList({
  items: controlledItems,
  defaultItems = [],
  onReorder,
  flip = true,
  onStateChange,
  messages = DEFAULT_MESSAGES,
  renderItem,
  rowClassName,
  className
}: {
  /** Controlled item order; pair with onReorder. Omit for uncontrolled. */
  items?: ReorderItem[]
  defaultItems?: ReorderItem[]
  onReorder?: (items: ReorderItem[]) => void
  /** false = hard snap, no glides/FLIP. */
  flip?: boolean
  onStateChange?: (state: ReorderState) => void
  messages?: ReorderMessages
  /** 行内容的逃生舱（默认渲染 label + meta + 序号）。
   *
   *  🔴 只换**内容**，不动 grip、不动 `<li>` 壳、不动交互内核（指针/FLIP/键盘全在壳上）。
   *  给它是为了让富卡片（如事项干系人：头像 / 角色 / 等待态 / hover 动作）也能拖，
   *  而不必把基座抄一份。不传 = 与移植版逐字节一致。 */
  renderItem?: (item: ReorderItem, index: number) => React.ReactNode
  /** 追加到每行卡片上的类（如富内容需要更大的行内边距）。 */
  rowClassName?: string
  className?: string
}): React.ReactElement {
  const [uncontrolled, setUncontrolled] = useState(controlledItems ?? defaultItems)
  const items = controlledItems ?? uncontrolled
  const setItems = (updater: (list: ReorderItem[]) => ReorderItem[]): void => {
    const next = updater(items)
    if (controlledItems === undefined) setUncontrolled(next)
    onReorder?.(next)
  }

  const [dragging, setDragging] = useState<{ id: string; from: number } | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [grabbed, setGrabbed] = useState<{ id: string; from: number } | null>(null)
  const [lastMove, setLastMove] = useState<{ label: string; from: number; to: number } | null>(null)
  const [announce, setAnnounce] = useState('')

  const listRef = useRef<HTMLUListElement>(null)
  const flipRectsRef = useRef<Map<string, DOMRect> | null>(null)
  const dragRef = useRef<DragData | null>(null)
  const grabSnapshotRef = useRef<ReorderItem[] | null>(null)
  const justDraggedRef = useRef(false)
  // One y motion value per row id - the single writing channel for all three
  // motion systems, so they can never fight over a transform.
  const yMapRef = useRef(new Map<string, MotionValue<number>>())
  const reduced = useReducedMotion()

  const yFor = (id: string): MotionValue<number> => {
    let mv = yMapRef.current.get(id)
    if (!mv) {
      mv = motionValue(0)
      yMapRef.current.set(id, mv)
    }
    return mv
  }

  const rowNodes = (): HTMLLIElement[] => [
    ...(listRef.current?.querySelectorAll<HTMLLIElement>('[data-reorder-item]') ?? [])
  ]
  const glide = (mv: MotionValue<number>, to: number): void => {
    if (flip && !reduced) animate(mv, to, MOVE)
    else mv.jump(to)
  }

  // FLIP: after any commit that captured First rects, zero everyone, measure the
  // clean layout, invert, then animate() home.
  useLayoutEffect(() => {
    const prev = flipRectsRef.current
    flipRectsRef.current = null
    const list = listRef.current
    if (!prev || !list) return
    const rows = rowNodes()
    for (const row of rows) yFor(row.dataset.id!).jump(0)
    void list.offsetWidth
    if (flip && !reduced) {
      for (const row of rows) {
        const before = prev.get(row.dataset.id!)
        if (!before) continue
        const dy = before.top - row.getBoundingClientRect().top
        if (dy) {
          const mv = yFor(row.dataset.id!)
          mv.jump(dy) // Invert: hold the old pixels
          animate(mv, 0, MOVE) // Play: glide home
        }
      }
    }
  }, [items, flip, reduced])

  useEffect(() => {
    onStateChange?.({
      order: items.map((item) => item.label),
      dragging: dragging ? (items.find((item) => item.id === dragging.id)?.label ?? null) : null,
      from: dragging?.from ?? grabbed?.from ?? null,
      to: dragging ? target : grabbed ? items.findIndex((item) => item.id === grabbed.id) : null,
      grabbed: Boolean(grabbed),
      lastMove
    })
  }, [items, dragging, target, grabbed, lastMove, onStateChange])

  function moveItem(list: ReorderItem[], from: number, to: number): ReorderItem[] {
    const next = [...list]
    const [picked] = next.splice(from, 1)
    next.splice(to, 0, picked)
    return next
  }

  function commitOrder(from: number, to: number): void {
    const list = listRef.current
    if (!list) return
    const rects = new Map<string, DOMRect>()
    for (const row of rowNodes()) rects.set(row.dataset.id!, row.getBoundingClientRect())
    flipRectsRef.current = rects
    const moved = items[from]
    setItems((current) => moveItem(current, from, to))
    setLastMove({ label: moved.label, from: from + 1, to: to + 1 })
  }

  function handlePointerDown(event: React.PointerEvent<HTMLLIElement>, index: number): void {
    if (dragRef.current) return
    if (event.button !== undefined && event.button !== 0) return
    const row = event.currentTarget
    row.setPointerCapture(event.pointerId)
    dragRef.current = {
      row,
      pointerId: event.pointerId,
      index,
      startY: event.clientY,
      active: false,
      slot: 0,
      to: index
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLLIElement>): void {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const dy = event.clientY - drag.startY
    if (!drag.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return
      const rows = rowNodes()
      drag.active = true
      drag.slot =
        rows.length > 1
          ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
          : rows[0].offsetHeight
      drag.rows = rows
      setDragging({ id: drag.row.dataset.id!, from: drag.index })
      setTarget(drag.index)
    }
    const max = (items.length - 1 - drag.index) * drag.slot
    const min = -drag.index * drag.slot
    let offset = dy
    if (offset > max) offset = max + (offset - max) / 4
    if (offset < min) offset = min + (offset - min) / 4
    // The hand gets no easing: jump(), never animate().
    yFor(drag.row.dataset.id!).jump(offset)

    const to = Math.max(
      0,
      Math.min(
        items.length - 1,
        Math.round((drag.index * drag.slot + Math.max(min, Math.min(max, dy))) / drag.slot)
      )
    )
    if (to !== drag.to) {
      drag.to = to
      setTarget(to)
      drag.rows!.forEach((row, j) => {
        if (row === drag.row) return
        let shift = 0
        if (drag.index < j && j <= to) shift = -drag.slot
        if (to <= j && j < drag.index) shift = drag.slot
        glide(yFor(row.dataset.id!), shift)
      })
    }
  }

  function settleAll(drag: DragData): void {
    glide(yFor(drag.row.dataset.id!), 0)
    drag.rows?.forEach((row) => {
      if (row !== drag.row) glide(yFor(row.dataset.id!), 0)
    })
  }

  function handlePointerUp(event: React.PointerEvent<HTMLLIElement>): void {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (!drag.active) return
    justDraggedRef.current = true
    setDragging(null)
    setTarget(null)
    if (drag.to !== drag.index) commitOrder(drag.index, drag.to)
    else settleAll(drag)
  }

  function cancelPointerDrag(): void {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (!drag.active) return
    justDraggedRef.current = true
    setDragging(null)
    setTarget(null)
    settleAll(drag)
  }

  useEffect(() => {
    if (!dragging) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancelPointerDrag()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dragging])

  function handleGripKeyDown(
    event: { key: string; preventDefault: () => void },
    index: number
  ): void {
    const item = items[index]
    const isGrabbed = grabbed?.id === item.id
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (isGrabbed) {
        setGrabbed(null)
        grabSnapshotRef.current = null
        setAnnounce(messages.dropped(item.label, index + 1, items.length))
      } else {
        setGrabbed({ id: item.id, from: index })
        grabSnapshotRef.current = items
        setAnnounce(messages.grabbed(item.label, index + 1, items.length))
      }
    } else if (isGrabbed && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const to = event.key === 'ArrowUp' ? index - 1 : index + 1
      if (to < 0 || to >= items.length) return
      commitOrder(index, to)
      setAnnounce(messages.moved(item.label, to + 1, items.length))
      requestAnimationFrame(() => {
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-reorder-grip]')[to]?.focus()
      })
    } else if (isGrabbed && event.key === 'Escape') {
      event.preventDefault()
      const snapshot = grabSnapshotRef.current
      grabSnapshotRef.current = null
      setGrabbed(null)
      if (snapshot && snapshot !== items) {
        const from = items.findIndex((entry) => entry.id === item.id)
        const to = snapshot.findIndex((entry) => entry.id === item.id)
        commitOrder(from, to)
      }
      setAnnounce(messages.cancelled(item.label))
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn('relative w-full', className)}>
        <ul
          className="relative flex flex-col gap-2"
          ref={listRef}
          role="list"
          aria-label={messages.listLabel}
        >
          {items.map((item, index) => {
            const isDragged = dragging?.id === item.id
            const isGrabbed = grabbed?.id === item.id
            const lifted = isDragged || isGrabbed
            return (
              <motion.li
                key={item.id}
                data-id={item.id}
                data-reorder-item
                className={`relative touch-none select-none ${lifted ? 'z-10' : ''}`}
                style={{ y: yFor(item.id) }}
                onPointerDown={(event) => handlePointerDown(event, index)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={cancelPointerDrag}
              >
                <motion.div
                  className={cn(
                    'reorder-card flex items-center gap-2.5 py-2.5 pl-2 pr-3.5 bg-card rounded-xl',
                    lifted ? 'reorder-card-lifted cursor-grabbing' : 'cursor-grab',
                    rowClassName
                  )}
                  initial={false}
                  animate={lifted ? { scale: 1.02 } : { scale: 1 }}
                  transition={LIFT}
                >
                  <button
                    type="button"
                    data-reorder-grip
                    className="grid place-items-center w-9 h-9 rounded-lg text-muted-foreground/70 cursor-grab [transition:background-color_200ms_ease,color_200ms_ease] hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                    aria-label={messages.grip(item.label, index + 1, items.length, isGrabbed)}
                    aria-pressed={isGrabbed}
                    onKeyDown={(event) => handleGripKeyDown(event, index)}
                    onClick={(event) => {
                      if (justDraggedRef.current) {
                        justDraggedRef.current = false
                        return
                      }
                      if (event.detail > 0)
                        handleGripKeyDown({ key: ' ', preventDefault: () => {} }, index)
                    }}
                  >
                    <GripIcon />
                  </button>
                  {renderItem ? (
                    <span className="min-w-0 flex-1">{renderItem(item, index)}</span>
                  ) : (
                    <>
                      <span className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-medium text-foreground whitespace-nowrap overflow-hidden text-ellipsis">
                          {item.label}
                        </span>
                        {item.meta && (
                          <span className="text-[0.6875rem] text-muted-foreground/70">
                            {item.meta}
                          </span>
                        )}
                      </span>
                      <span
                        className="flex-none text-xs font-medium text-muted-foreground/70 tabular-nums"
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                    </>
                  )}
                </motion.div>
              </motion.li>
            )
          })}
        </ul>

        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </div>
    </MotionConfig>
  )
}

function GripIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="5" r="1.7" />
      <circle cx="15" cy="5" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="19" r="1.7" />
      <circle cx="15" cy="19" r="1.7" />
    </svg>
  )
}
