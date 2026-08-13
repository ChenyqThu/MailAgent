// useEnterAnimation — 只有进场的浮层动效（`useExitAnimation` 的半条）。
//
// 为什么需要它：`useExitAnimation` 把「卸载」收进自己手里，前提是组件能拿到 `open` 布尔、
// 且**关闭期间内容还在**。仓里有一类浮层不满足这个前提 —— 父组件直接 `{state ? <Panel …/> :
// null}` 硬挂载，面板的数据也跟着那个 state 一起消失（提案审阅的 update、跟进配置的
// 快照、运行浮层的 run）。给它们接退场要把父级的数据保活改造一遍，收益却只有 120ms 的淡出。
// 这类就只做进场：设计 §1.4a 的 `popIn` 本来定义的也就是入场。
//
// 🔴 reduced-motion 必须在 JS 层短路：GSAP 直接写 .style，index.css 的
// `@media (prefers-reduced-motion)` 对被它接管的元素失效（见 docs/motion-gsap.md §3）。
//
// 用法：
//   const scopeRef = useEnterAnimation<HTMLDivElement>({ card: '[data-anim-card]' })
//   return <div ref={scopeRef} …><section data-anim-card …>…</section></div>

import { useRef } from 'react'

import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export interface EnterAnimationOpts {
  /** 卡片子元素选择器（做 transform 补间）。省略时 scope 根即卡片。 */
  card?: string
  /** 遮罩来源：`true` 时 scope 根淡入（DUR.fast），`string` 时取 scope 内子元素。默认无遮罩。 */
  backdrop?: boolean | string
  /** 卡片进场起始 vars。默认 { autoAlpha:0, y:8, scale:0.97 }（同 useExitAnimation）。 */
  from?: gsap.TweenVars
  /** 进场时长。默认 DUR.base。 */
  duration?: number
  /**
   * 追加的重跑依赖。
   *
   * 🔴 默认只依赖 reduced-motion，前提是「组件首帧就把 scope 节点渲染出来」。浮层若要先量
   * 锚点、下一帧才挂 DOM（`useAnchoredPosition` 那类），首帧 effect 跑时 scope 还是 null，
   * 而后续挂载不会让 effect 重跑 —— 表现成"这个浮层没有动效"。把挂载条件放进来即可。
   */
  deps?: readonly unknown[]
}

const DEFAULT_FROM: gsap.TweenVars = { autoAlpha: 0, y: 8, scale: 0.97 }

export function useEnterAnimation<T extends HTMLElement = HTMLDivElement>(
  opts: EnterAnimationOpts = {}
): React.RefObject<T | null> {
  const { card, backdrop = false, from, duration = DUR.base, deps } = opts
  const cardFrom = from ?? DEFAULT_FROM
  const scopeRef = useRef<T>(null)
  const reduce = useReducedMotion()

  useGSAP(
    () => {
      const root = scopeRef.current
      if (!root) return
      const cardEl = card ? root.querySelector<HTMLElement>(card) : root
      if (!cardEl) return
      const backdropEl =
        backdrop === true
          ? root
          : typeof backdrop === 'string'
            ? root.querySelector<HTMLElement>(backdrop)
            : null
      const hasBackdrop = backdropEl !== null && backdropEl !== cardEl

      if (reduce) {
        // 清掉可能残留的内联样式，元素直接就位。
        //
        // 🔴 **只清本 hook 会写的那几个属性，绝不 `clearProps:'all'`**：浮层的几何常常只能
        // 走内联 style（锚点算出来的 top/left/width 没法写成 Tailwind 字面量），`all` 会把
        // 它们一并抹掉、而 React 不会因为值没变再写回 —— 表现成"开了系统减少动效的机器上
        // 浮层跑到左上角"。`MatterLinkPopoverPortal` 的定位断言就是这条的闸。
        if (hasBackdrop) gsap.set(backdropEl, { clearProps: 'opacity,visibility' })
        gsap.set(cardEl, { clearProps: 'opacity,visibility,transform,transformOrigin' })
        return
      }
      const tl = gsap.timeline()
      if (hasBackdrop) {
        tl.fromTo(backdropEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast }, 0)
      }
      // clearProps:'transform' —— 进场结束把 transform 交还 CSS，别把居中/定位类冲掉。
      tl.fromTo(
        cardEl,
        cardFrom,
        { autoAlpha: 1, y: 0, scale: 1, duration, clearProps: 'transform' },
        0
      )
    },
    { dependencies: [reduce, ...(deps ?? [])], scope: scopeRef }
  )

  return scopeRef
}
