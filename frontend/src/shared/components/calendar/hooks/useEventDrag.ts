// Lane C (#5) — timeline 事件块的指针拖拽 (改期 / 改时长)。
//
// 落点求解全在 lib/timeGrid.computeDragResult (纯函数, 单测覆盖); 这里只管
// 指针会话: 起手阈值、容器滚动补偿、近边缘自动滚动、Escape 取消、以及拖完
// 吞掉那一下 click (否则松手就把抽屉打开了)。
//
// 监听挂 window 而不是块本身: 指针一旦离开块 (拖拽必然离开) 元素上的
// pointermove 就断了。setPointerCapture 也能做, 但 window 监听在测试环境里
// 语义更直白。
//
// 🔴 不设 touch-action:none —— 那会让触屏上「从事件块起手滚动网格」失效。
// 触屏走 pointercancel 分支干净放弃, 拖拽是鼠标/触控板的能力。

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DRAG_THRESHOLD_PX,
  computeDragResult,
  minutesToPx,
  type DragMode,
  type DragResult
} from '../lib/timeGrid'

/** day / week 视图共用的滚动容器 (两个视图的 timeline 都是 .wk-body)。 */
const SCROLL_HOST_SELECTOR = '.wk-body'
/** 指针进入容器上下边缘这么多 px 内开始自动滚动。 */
const EDGE_PX = 28
/** 每帧滚动步长 px。 */
const EDGE_STEP_PX = 8

export interface EventDragCommit {
  mode: DragMode
  startMs: number
  endMs: number
}

interface Options {
  /** 当前显示的起止 (含乐观 override) —— 拖拽以「看到的位置」为基准。 */
  startMs: number
  endMs: number
  /** 块顶相对当日 00:00 的 px 偏移。 */
  topPx: number
  enabled: boolean
  onCommit: (commit: EventDragCommit) => void
}

export interface EventDragApi {
  isDragging: boolean
  /** 预览: 块顶位移 px (move 模式)。 */
  offsetPx: number
  /** 预览: 块高增量 px (resize 模式)。 */
  heightDeltaPx: number
  startDrag: (e: React.PointerEvent, mode: DragMode) => void
  /** 真拖拽刚结束时吞掉紧随的 click。读一次即复位。 */
  consumeClickSuppression: () => boolean
}

interface Session {
  mode: DragMode
  base: { startMs: number; endMs: number; topPx: number }
  originClientY: number
  originScrollTop: number
  scrollHost: HTMLElement | null
  lastClientY: number
  moved: boolean
  canceled: boolean
  result: DragResult
  rafId: number | null
  teardown: () => void
}

export function useEventDrag({ startMs, endMs, topPx, enabled, onCommit }: Options): EventDragApi {
  // 预览带上本次会话的基准 —— 位移 px 必须相对「起手时的位置」算, 不是相对当前
  // props (拖拽期间数据刷新会让两者不等, 那时块会跳)。
  const [preview, setPreview] = useState<{
    mode: DragMode
    base: { startMs: number; endMs: number }
    result: DragResult
  } | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const suppressClickRef = useRef(false)

  // 会话在 startDrag 里一次性建立并捕获当时的基准值/回调, 拖拽期间 props 变化
  // 不影响本次会话 (拖到一半基准被换掉才是 bug)。
  const startDrag = useCallback(
    (e: React.PointerEvent, mode: DragMode): void => {
      if (!enabled || e.button !== 0 || sessionRef.current) return
      // 上一次拖拽的抑制位若没人来消费 (松手时指针已离开块 → click 派发到共同
      // 祖先, 块自己的 onClick 根本没跑), 留着会吞掉下一次真点击。新交互开始即清。
      suppressClickRef.current = false

      const host = (e.currentTarget as HTMLElement).closest<HTMLElement>(SCROLL_HOST_SELECTOR)
      const session: Session = {
        mode,
        base: { startMs, endMs, topPx },
        originClientY: e.clientY,
        originScrollTop: host?.scrollTop ?? 0,
        scrollHost: host,
        lastClientY: e.clientY,
        moved: false,
        canceled: false,
        result: { startMs, endMs, changed: false },
        rafId: null,
        teardown: () => {}
      }

      const recompute = (): void => {
        if (session.canceled) return
        const scrollDelta = session.scrollHost
          ? session.scrollHost.scrollTop - session.originScrollTop
          : 0
        const dyPx = session.lastClientY - session.originClientY + scrollDelta
        if (!session.moved) {
          if (Math.abs(dyPx) < DRAG_THRESHOLD_PX) return
          session.moved = true
          document.body.style.userSelect = 'none'
        }
        session.result = computeDragResult({ mode: session.mode, ...session.base, dyPx })
        setPreview({ mode: session.mode, base: session.base, result: session.result })
      }

      const onMove = (ev: PointerEvent): void => {
        session.lastClientY = ev.clientY
        recompute()
      }
      const finish = (commit: boolean): void => {
        session.teardown()
        sessionRef.current = null
        setPreview(null)
        if (session.moved) suppressClickRef.current = true
        if (commit && session.moved && session.result.changed) {
          onCommit({
            mode: session.mode,
            startMs: session.result.startMs,
            endMs: session.result.endMs
          })
        }
      }
      const onUp = (): void => finish(!session.canceled)
      const onPointerCancel = (): void => finish(false)
      const onKeyDown = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape' || session.canceled) return
        // 只吃掉这一次 Escape (日历页 Esc 另有关弹层语义), 并就地回弹;
        // 会话留到 pointerup 才拆, 好让那一下 click 照样被吞掉。
        ev.preventDefault()
        ev.stopPropagation()
        session.canceled = true
        session.result = {
          startMs: session.base.startMs,
          endMs: session.base.endMs,
          changed: false
        }
        setPreview(null)
      }
      // 指针停在边缘不动时 pointermove 不再触发, 自动滚动必须自己有节拍。
      const tick = (): void => {
        session.rafId = requestAnimationFrame(tick)
        const host = session.scrollHost
        if (!host || !session.moved || session.canceled) return
        const rect = host.getBoundingClientRect()
        // 容器没高度 / 内容不溢出时没有「边缘」可言, 别对着 0 高矩形算出恒定滚动。
        if (rect.height <= 0 || host.scrollHeight <= host.clientHeight) return
        let step = 0
        if (session.lastClientY < rect.top + EDGE_PX) step = -EDGE_STEP_PX
        else if (session.lastClientY > rect.bottom - EDGE_PX) step = EDGE_STEP_PX
        if (step === 0) return
        const before = host.scrollTop
        host.scrollTop = before + step
        if (host.scrollTop !== before) recompute()
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('keydown', onKeyDown, true)
      if (session.scrollHost && typeof requestAnimationFrame === 'function') {
        session.rafId = requestAnimationFrame(tick)
      }
      session.teardown = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        window.removeEventListener('keydown', onKeyDown, true)
        if (session.rafId !== null) cancelAnimationFrame(session.rafId)
        if (session.moved) document.body.style.userSelect = ''
      }
      sessionRef.current = session
    },
    [enabled, startMs, endMs, topPx, onCommit]
  )

  // 拖到一半块被卸载 (切视图 / 数据刷新) 时别把 window 监听和 userSelect 留下。
  useEffect(() => {
    return () => {
      sessionRef.current?.teardown()
      sessionRef.current = null
    }
  }, [])

  const consumeClickSuppression = useCallback((): boolean => {
    if (!suppressClickRef.current) return false
    suppressClickRef.current = false
    return true
  }, [])

  const offsetPx =
    preview && preview.mode === 'move'
      ? minutesToPx((preview.result.startMs - preview.base.startMs) / 60_000)
      : 0
  const heightDeltaPx =
    preview && preview.mode === 'resize'
      ? minutesToPx((preview.result.endMs - preview.base.endMs) / 60_000)
      : 0

  return {
    isDragging: preview !== null,
    offsetPx,
    heightDeltaPx,
    startDrag,
    consumeClickSuppression
  }
}
