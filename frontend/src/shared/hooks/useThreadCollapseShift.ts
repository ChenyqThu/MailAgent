// 线程收起过渡（方案 A + 幽灵退场，2026-08 dogfood 二轮）。
//
// 展开早有入场动画（CSS thread-child-in + revealThreadId 一次性标记），收起在
// 78d55e56 之前是零动效：子行从 rows 数组直接摘除 → react-window rowCount 变小 →
// 同步 unmount，下方所有行瞬间上移 Σ(子行高度)。方案 A 补了下方行的手工 FLIP
// 位移；dogfood 反馈「比之前还差」的根因是**被摘除的子行没有任何退场** ——
// 第一帧内容直接消失，露出一个 Σ 高的空洞，再由 220ms 位移把洞合上，观感是
// 「闪没 → 空洞 → 滑动」。本版补上缺的那一段：收起前克隆子行节点作幽灵层，
// fade + 上浮退场（thread-child-in 入场 from -6px 的镜像），与位移 tween 同步播。
//
// 手工 FLIP，一次性：
//   First — 点 chevron 收起**之前**在 handleToggleThread 里 capture() 记下
//           rows / rowHeights / scrollTop（rows 与 rowHeights 都是 useMemo 产出的
//           不可变数组，存引用即是快照），并**克隆当前挂载的全部线程子行节点**
//           （提交后本尊已被 React 摘除，layout effect 里再想抓就晚了；手风琴
//           不变量 = 同一时刻至多一条线程展开，所以「挂载中的全部子行」恰好就是
//           即将被摘除的候选集，真正用不用由差分决定，没被摘除的克隆直接丢弃）。
//   Last  — 收起提交后的 layout effect 里按同样口径算新几何。
//   Invert— computeCollapseShifts 差出每个存活行的视觉位移，**同步**写进 inline
//           translate（在 paint 之前，不等 tween 首帧，否则会先闪一帧新位置）；
//           collectRemovedChildKeys 差出被摘除的子行，对应克隆此刻才挂进容器。
//   Play  — 单条 timeline：进度对象把存活行的 translate 收回 0（DUR.base），
//           幽灵 autoAlpha 快淡出（DUR.fast）+ 位移向 -6px 上浮（入场镜像）。
//
// 🔴 硬约束（docs/motion-gsap.md §1 虚拟列表 + DESIGN.md §8）：
//   1. 只动 **独立 translate 属性** + autoAlpha，绝不动 transform / height。
//      react-window v2 把行定位写成 inline `transform: translateY(<offset>)`，
//      动 transform 会连定位一起冲掉；translate 与 transform 复合，互不干扰。
//   2. 一次性：pendingRef 在 layout effect 里立刻消费掉，之后因滚动重挂的行不会
//      被碰到（虚拟列表里按静态状态驱动动画 = 每次滚回视口重播一遍）。
//   3. tween 随 unmount kill，且**任何一次行重排都先收掉在途位移 + 摘掉幽灵**
//      —— 行的 translateY 定位已经变了，残留的 translate 会把行画到错的地方
//      （快速连点「收起 A → 立刻展开 B」正好撞上这条）。
//   4. 幽灵是 React 之外的旁挂节点：必须 aria-hidden（兼作 react-window 行索引
//      标注的豁免记号，与它自己的 sizing div 同款）、摘掉 data-row-key（不许被
//      下一轮差分查询命中）、摘掉 data-thread-reveal（不许重播陈旧入场动画）、
//      pointer-events:none，且随 clearActive / 卸载一起 remove。

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { ListImperativeAPI } from 'react-window'

import { gsap, DUR } from '@shared/lib/gsap'
import {
  ROW_KEY_ATTR,
  ROW_KEY_SELECTOR,
  collectRemovedChildKeys,
  computeCollapseShifts,
  rowIdentityKey,
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

// 幽灵退场的上浮终点：thread-child-in 入场 `from { translate: 0 -6px }` 的镜像。
const GHOST_EXIT_DRIFT_PX = -6

/** 把 capture 时的克隆整备成幽灵节点（见文件头硬约束 4）。 */
function prepGhost(clone: HTMLElement, dy: number): void {
  clone.removeAttribute(ROW_KEY_ATTR)
  clone.removeAttribute('data-react-window-index')
  clone.removeAttribute('data-thread-reveal')
  clone.setAttribute('aria-hidden', 'true')
  clone.style.pointerEvents = 'none'
  // ride 项：clamp（靠底收起时浏览器把 scrollTop 拉回）发生在提交与首帧之间，
  // 不补这一项幽灵会在第一帧先跳一下、再开始淡出，与同侧存活行脱节。
  if (dy !== 0) setShift(clone, dy)
}

interface PendingSnapshot extends RowGeometrySnapshot {
  /** capture 时克隆的挂载中子行节点，键 = rowIdentityKey。 */
  clones: Map<string, HTMLElement>
}

interface ActiveTransition {
  tween: ReturnType<typeof gsap.timeline>
  els: HTMLElement[]
  ghosts: HTMLElement[]
}

export interface UseThreadCollapseShiftOptions {
  rows: ReadonlyArray<ListRow>
  rowHeights: ReadonlyArray<number>
  listRef: RefObject<ListImperativeAPI | null>
  /** reduced-motion（GSAP 直写 .style，绕过 CSS 媒体查询，必须在 JS 层短路）。 */
  reduceMotion: boolean
}

export interface UseThreadCollapseShiftReturn {
  /** 收起**之前**调用，记下 First 帧几何 + 克隆子行。展开路径不要调（那条有滚动锚定 tween）。 */
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
  const pendingRef = useRef<PendingSnapshot | null>(null)
  const activeRef = useRef<ActiveTransition | null>(null)
  const isShiftingRef = useRef(false)

  // 收掉在途过渡：kill timeline + 清 translate 残留 + 摘幽灵 + 放开分页闸。
  // 已完成的 timeline 在 onComplete 里走同一条路径（kill 跑完的 tween 是 no-op）。
  const clearActive = useCallback((): void => {
    const active = activeRef.current
    if (!active) return
    activeRef.current = null
    isShiftingRef.current = false
    active.tween.kill()
    for (const el of active.els) clearShift(el)
    for (const g of active.ghosts) g.remove()
  }, [])

  const captureCollapse = useCallback((): void => {
    if (reduceMotion) return
    const el = listRef.current?.element
    if (!el) return
    // 克隆挂载中的线程子行（此刻 DOM 还是展开态）。视口外的子行没挂载也就没有
    // 克隆 —— 它们本来就不可见，不需要退场。
    const childKeys = new Set<string>()
    for (const r of rows) {
      if (r.type === 'email' && r.thread !== undefined && !r.thread.isHead) {
        childKeys.add(rowIdentityKey(r))
      }
    }
    const clones = new Map<string, HTMLElement>()
    if (childKeys.size > 0) {
      for (const node of el.querySelectorAll<HTMLElement>(ROW_KEY_SELECTOR)) {
        const key = node.getAttribute(ROW_KEY_ATTR)
        if (key !== null && childKeys.has(key)) {
          clones.set(key, node.cloneNode(true) as HTMLElement)
        }
      }
    }
    pendingRef.current = { rows, heights: rowHeights, scrollTop: el.scrollTop, clones }
  }, [reduceMotion, listRef, rows, rowHeights])

  useLayoutEffect(() => {
    clearActive()
    const before = pendingRef.current
    pendingRef.current = null
    if (!before) return
    const el = listRef.current?.element
    if (!el) return
    const after: RowGeometrySnapshot = {
      rows,
      heights: rowHeights,
      // 读的是**提交后**的 scrollTop：总高变矮时浏览器已在此刻把它 clamp 到新的
      // 最大值，视觉差里带上这一项，靠近底部收起的整列跳动被同一个 tween 吸收。
      scrollTop: el.scrollTop
    }
    const shifts = computeCollapseShifts(before, after)

    // 幽灵退场：真被摘除的子行才用克隆（capture 是「全部挂载子行」的超集快照，
    // 没被摘掉的克隆直接丢弃 —— 例如 capture 后这次重排根本没动线程）。
    // ride 项 = 内容坐标不变的行的视觉差（clamp 时与收起点上方的存活行同值同步）。
    const ghostDy = after.scrollTop - before.scrollTop
    const ghosts: HTMLElement[] = []
    for (const key of collectRemovedChildKeys(before.rows, rows)) {
      const clone = before.clones.get(key)
      if (!clone) continue
      prepGhost(clone, ghostDy)
      ghosts.push(clone)
    }
    if (shifts.size === 0 && ghosts.length === 0) return

    const targets: Array<{ el: HTMLElement; dy: number }> = []
    for (const node of el.querySelectorAll<HTMLElement>(ROW_KEY_SELECTOR)) {
      const dy = shifts.get(node.getAttribute(ROW_KEY_ATTR) ?? '')
      if (dy === undefined) continue
      setShift(node, dy)
      targets.push({ el: node, dy })
    }
    if (targets.length === 0 && ghosts.length === 0) return

    // 幽灵挂在滚动容器末尾：内容坐标定位（克隆自带 react-window 的 inline
    // transform: translateY），随滚动自然移动；末尾兄弟 = 画在存活行之上，
    // 淡出期间滑入的行从其下方经过。挂载晚于上面的 scrollTop 读取 —— 幽灵会把
    // scrollHeight 暂时撑回旧值，先读再挂才能拿到 clamp 后的真值。
    for (const g of ghosts) el.appendChild(g)

    const prog = { t: 0 }
    const tl = gsap.timeline({ onComplete: clearActive })
    tl.to(
      prog,
      {
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
          for (const g of ghosts) {
            if (!g.isConnected) continue
            // ride 项收敛 + 向 -6px 上浮（入场镜像）；DUR.fast 淡出先一步把幽灵
            // 隐掉，可见段只走到漂移中途，刻意如此（退场要快进要稳）。
            setShift(g, ghostDy + (GHOST_EXIT_DRIFT_PX - ghostDy) * prog.t)
          }
        }
      },
      0
    )
    if (ghosts.length > 0) {
      tl.to(ghosts, { autoAlpha: 0, duration: DUR.fast, ease: 'standard' }, 0)
    }
    activeRef.current = { tween: tl, els: targets.map((s) => s.el), ghosts }
    isShiftingRef.current = true
  }, [rows, rowHeights, listRef, clearActive])

  useEffect(() => clearActive, [clearActive])

  return { captureCollapse, isShiftingRef }
}
