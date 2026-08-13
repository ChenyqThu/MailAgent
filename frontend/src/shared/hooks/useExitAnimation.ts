// useExitAnimation — 统一 overlay 进/退场 + 延迟卸载。
//
// 解决全 app 最普遍的缺口：React 条件渲染 `{isOpen && ...}` 同步卸载，CSS
// 没机会播退场动画（"进场有、退场硬切"）。本 hook 把卸载推迟到退场动画
// 播完。返回 `shouldRender = isOpen || 退场进行中`，组件用
// `{shouldRender && <Overlay ref={scopeRef}/>}` 替换 `{isOpen && ...}`。
//
// 约定：淡入淡出一律 autoAlpha（隐藏时自动 visibility:hidden，不挡点击）。
// reduced-motion 时跳过动画直接切换。所有 tween 经 useGSAP scope 自动 cleanup。
//
// 用法（模态：backdrop 淡入 + 卡片位移缩放）：
//   const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, { card: '[data-anim-card]' })
//   if (!shouldRender) return null
//   return createPortal(<div ref={scopeRef} ...><div data-anim-card ...>…</div></div>, document.body)
//
// 用法（popover：单元素，无 backdrop，从右上微展开）：
//   useExitAnimation(open, { backdrop: false, from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' }, enterDuration: DUR.fast })

import { useRef, useState } from 'react'

import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export interface ExitAnimationOpts {
  /** 卡片子元素选择器（用 transform 动画）。省略时 scope 根即卡片。 */
  card?: string
  /**
   * backdrop（独立淡入，DUR.fast）的来源：
   *   true（默认）  scope 根即 backdrop（root 包裹卡片的模态）
   *   string        backdrop 是 scope 内的子元素（如 CommandPalette 的 veil/pane 兄弟结构）
   *   false         无 backdrop（popover/单元素）
   */
  backdrop?: boolean | string
  /** 卡片进场起始 vars（也是退场目标）。默认 { autoAlpha:0, y:8, scale:0.97 }。 */
  from?: gsap.TweenVars
  /**
   * 进场终点的**补充** vars，合并在默认 `{autoAlpha:1, y:0, scale:1}` 之上。
   *
   * 🔴 需要它的唯一场景：`from` 里带了默认终点没有的位移轴（如 slide-over 的 `x:24`）。
   * GSAP 的 `fromTo` 只补间「to 里列出的」属性，from 独有的属性会被当成 `set` 一直留着 ——
   * CommandPalette 的 `xPercent:-50` 正是**故意**吃这条语义把居中留住；而水平滑入需要它
   * 真的动回 0，就必须在这里补 `{x:0}`，否则整段滑入会退化成「结束时 clearProps 一下瞬移」。
   * 默认 undefined ⇒ 既有 20 处调用点逐字节不变。
   */
  to?: gsap.TweenVars
  /** 进场时长。默认 DUR.base。 */
  enterDuration?: number
  /** 退场时长。默认 DUR.fast。 */
  exitDuration?: number
  /**
   * 进场时让 backdrop 淡入与卡片同时长（enterDuration）、同起止，而非默认 DUR.fast。
   * 用于 slide-over 等卡片大幅位移场景：遮罩快淡入(0.12s)与抽屉慢滑入(0.22s)不同步会
   * 显得"遮罩先啪一下、抽屉再慢慢滑"脱节；同步后两者一起进来，连贯。默认 false
   * （模态卡片微动场景维持遮罩快淡入的既有手感）。退场两者本就同 exitDuration，不受影响。
   */
  syncBackdrop?: boolean
}

export interface ExitAnimationReturn<T extends HTMLElement> {
  shouldRender: boolean
  scopeRef: React.RefObject<T | null>
}

const DEFAULT_FROM: gsap.TweenVars = { autoAlpha: 0, y: 8, scale: 0.97 }

export function useExitAnimation<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  opts: ExitAnimationOpts = {}
): ExitAnimationReturn<T> {
  const {
    card,
    backdrop = true,
    from,
    to,
    enterDuration = DUR.base,
    exitDuration = DUR.fast,
    syncBackdrop = false
  } = opts
  const cardFrom = from ?? DEFAULT_FROM

  const scopeRef = useRef<T>(null)
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen)
  const reduce = useReducedMotion()

  // 开启时立刻挂载：render 期间条件 setState（React 官方 "adjusting state during
  // render"，守卫 isOpen && !shouldRender 防循环），比 effect 少一帧 commit，元素更早
  // 入 DOM 让同轮 useGSAP 播进场。退场卸载仍在下方 useGSAP 的 onComplete。
  if (isOpen && !shouldRender) {
    setShouldRender(true)
  }

  useGSAP(
    () => {
      const root = scopeRef.current
      if (!root || !shouldRender) return
      const cardEl = card ? root.querySelector<HTMLElement>(card) : root
      if (!cardEl) return
      const backdropEl =
        backdrop === true
          ? root
          : typeof backdrop === 'string'
            ? root.querySelector<HTMLElement>(backdrop)
            : null
      const hasBackdrop = backdropEl !== null && backdropEl !== cardEl

      if (isOpen) {
        // 进场。reduced-motion 时清掉内联样式直接显示。
        if (reduce) {
          if (hasBackdrop) gsap.set(backdropEl, { clearProps: 'opacity,visibility' })
          gsap.set(cardEl, { clearProps: 'all' })
          return
        }
        const tl = gsap.timeline()
        if (hasBackdrop) {
          // syncBackdrop：与卡片同时长，遮罩与抽屉一起进来（slide-over 连贯感）。
          tl.fromTo(
            backdropEl,
            { autoAlpha: 0 },
            { autoAlpha: 1, duration: syncBackdrop ? enterDuration : DUR.fast },
            0
          )
        }
        tl.fromTo(
          cardEl,
          cardFrom,
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            ...to,
            duration: enterDuration,
            clearProps: 'transform'
          },
          0
        )
      } else {
        // 退场，播完真正卸载。reduced-motion 时立即卸载。
        if (reduce) {
          setShouldRender(false)
          return
        }
        const tl = gsap.timeline({ onComplete: () => setShouldRender(false) })
        tl.to(cardEl, { ...cardFrom, duration: exitDuration }, 0)
        if (hasBackdrop) {
          tl.to(backdropEl, { autoAlpha: 0, duration: exitDuration }, 0)
        }
      }
    },
    { dependencies: [isOpen, shouldRender, reduce], scope: scopeRef }
  )

  return { shouldRender, scopeRef }
}
