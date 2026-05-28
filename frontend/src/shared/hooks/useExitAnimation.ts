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

import { useEffect, useRef, useState } from 'react'

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
  /** 进场时长。默认 DUR.base。 */
  enterDuration?: number
  /** 退场时长。默认 DUR.fast。 */
  exitDuration?: number
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
  const { card, backdrop = true, from, enterDuration = DUR.base, exitDuration = DUR.fast } = opts
  const cardFrom = from ?? DEFAULT_FROM

  const scopeRef = useRef<T>(null)
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen)
  const reduce = useReducedMotion()

  // 开启时立刻挂载（下一次 render 元素入 DOM，useGSAP 随即播进场）。
  useEffect(() => {
    if (isOpen && !shouldRender) setShouldRender(true)
  }, [isOpen, shouldRender])

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
          tl.fromTo(backdropEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast }, 0)
        }
        tl.fromTo(
          cardEl,
          cardFrom,
          { autoAlpha: 1, y: 0, scale: 1, duration: enterDuration, clearProps: 'transform' },
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
