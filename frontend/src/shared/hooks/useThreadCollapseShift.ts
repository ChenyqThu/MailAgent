// 线程收起时下方行的位移过渡（方案 A，2026-08 owner 拍板）。
//
// 展开早有入场动画（CSS thread-child-in + revealThreadId 一次性标记），收起却是
// 零动效：子行从 rows 数组直接摘除 → react-window rowCount 变小 → 同步 unmount，
// 下方所有行瞬间上移 Σ(子行高度)。这里补的就是那一下瞬移。
//
// 手工 FLIP，一次性：
//   First — 点 chevron 收起**之前**在 handleToggleThread 里 capture() 记下
//           rows / rowHeights / scrollTop（rows 与 rowHeights 都是 useMemo 产出的
//           不可变数组，存引用即是快照）。
//   Last  — 收起提交后的 layout effect 里按同样口径算新几何。
//   Invert— computeCollapseShifts 差出每行的视觉位移，**同步**写进 inline
//           translate（在 paint 之前，不等 tween 首帧，否则会先闪一帧新位置）。
//   Play  — 单个 tween 驱动一个进度对象，onUpdate 里把各行的 translate 收回 0。
//
// 🔴 三条硬约束（docs/motion-gsap.md §1 虚拟列表 + DESIGN.md §8）：
//   1. 只动 **独立 translate 属性**，绝不动 transform / height。react-window v2
//      把行定位写成 inline `transform: translateY(<scrollOffset>px)`，动 transform
//      会连定位一起冲掉；translate 与 transform 复合（个别变换属性先于 transform
//      应用），互不干扰 —— 与既有 thread-child-in 入场动画同一纪律。
//   2. 一次性：pendingRef 在 layout effect 里立刻消费掉，之后因滚动重挂的行不会
//      被碰到（虚拟列表里按静态状态驱动动画 = 每次滚回视口重播一遍）。
//   3. tween 随 unmount kill，且**任何一次行重排都先收掉在途位移** —— 行的
//      translateY 定位已经变了，残留的 translate 会把行画到错的地方（快速连点
//      「收起 A → 立刻展开 B」正好撞上这条）。

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { ListImperativeAPI } from 'react-window'

import { gsap, DUR } from '@shared/lib/gsap'
import {
  ROW_KEY_ATTR,
  ROW_KEY_SELECTOR,
  computeCollapseShifts,
  type ListRow,
  type RowGeometrySnapshot
} from '@shared/components/email/emailListRows'

// 位移一律走 setProperty/removeProperty 而非 `style.translate = …` 赋值：`translate`
// 是个别变换属性（个别变换属性先于 transform 应用，与 react-window 的 inline
// transform 天然复合），但它的驼峰别名在非浏览器 DOM 实现里未必接进 CSS 声明块
// —— happy-dom 就只会把它挂成对象上的普通 JS 属性，样式**根本没写进去**。
// 用标准 API 才能保证「测试里断言到的」和「浏览器里画出来的」是同一件事。
const SHIFT_PROP = 'translate'
function setShift(el: HTMLElement, dy: number): void {
  el.style.setProperty(SHIFT_PROP, `0 ${dy}px`)
}
function clearShift(el: HTMLElement): void {
  el.style.removeProperty(SHIFT_PROP)
}

export interface UseThreadCollapseShiftOptions {
  rows: ReadonlyArray<ListRow>
  rowHeights: ReadonlyArray<number>
  listRef: RefObject<ListImperativeAPI | null>
  /** reduced-motion（GSAP 直写 .style，绕过 CSS 媒体查询，必须在 JS 层短路）。 */
  reduceMotion: boolean
}

export interface UseThreadCollapseShiftReturn {
  /** 收起**之前**调用，记下 First 帧几何。展开路径不要调（那条有滚动锚定 tween）。 */
  captureCollapse: () => void
  /** 位移 tween 在途 —— 与手风琴锚定同款，期间不让靠底的行触发分页预取。 */
  isShiftingRef: RefObject<boolean>
}

export function useThreadCollapseShift({
  rows,
  rowHeights,
  listRef,
  reduceMotion
}: UseThreadCollapseShiftOptions): UseThreadCollapseShiftReturn {
  const pendingRef = useRef<RowGeometrySnapshot | null>(null)
  const activeRef = useRef<{ tween: ReturnType<typeof gsap.to>; els: HTMLElement[] } | null>(null)
  const isShiftingRef = useRef(false)

  // 收掉在途位移：kill tween + 清 translate 残留 + 放开分页闸。已完成的 tween 在
  // onComplete 里走同一条路径（kill 一个跑完的 tween 是 no-op）。
  const clearActive = useCallback((): void => {
    const active = activeRef.current
    if (!active) return
    activeRef.current = null
    isShiftingRef.current = false
    active.tween.kill()
    for (const el of active.els) clearShift(el)
  }, [])

  const captureCollapse = useCallback((): void => {
    if (reduceMotion) return
    const el = listRef.current?.element
    if (!el) return
    pendingRef.current = { rows, heights: rowHeights, scrollTop: el.scrollTop }
  }, [reduceMotion, listRef, rows, rowHeights])

  useLayoutEffect(() => {
    clearActive()
    const before = pendingRef.current
    pendingRef.current = null
    if (!before) return
    const el = listRef.current?.element
    if (!el) return
    const shifts = computeCollapseShifts(before, {
      rows,
      heights: rowHeights,
      // 读的是**提交后**的 scrollTop：总高变矮时浏览器已在此刻把它 clamp 到新的
      // 最大值，视觉差里带上这一项，靠近底部收起的整列跳动被同一个 tween 吸收。
      scrollTop: el.scrollTop
    })
    if (shifts.size === 0) return

    const targets: Array<{ el: HTMLElement; dy: number }> = []
    for (const node of el.querySelectorAll<HTMLElement>(ROW_KEY_SELECTOR)) {
      const dy = shifts.get(node.getAttribute(ROW_KEY_ATTR) ?? '')
      if (dy === undefined) continue
      setShift(node, dy)
      targets.push({ el: node, dy })
    }
    if (targets.length === 0) return

    const prog = { t: 0 }
    const tween = gsap.to(prog, {
      t: 1,
      duration: DUR.base,
      ease: 'standard',
      onUpdate: () => {
        const remain = 1 - prog.t
        for (const s of targets) {
          // 虚拟化换出的行：节点已脱离文档，不再写（下次挂回来是静态的）。
          if (!s.el.isConnected) continue
          setShift(s.el, s.dy * remain)
        }
      },
      onComplete: clearActive
    })
    activeRef.current = { tween, els: targets.map((s) => s.el) }
    isShiftingRef.current = true
  }, [rows, rowHeights, listRef, clearActive])

  useEffect(() => clearActive, [clearActive])

  return { captureCollapse, isShiftingRef }
}
