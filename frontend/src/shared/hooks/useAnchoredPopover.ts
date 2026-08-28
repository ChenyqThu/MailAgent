// useAnchoredPopover — 把 portal 到 body 的 chrome 浮层横向钉在它的触发器上。
//
// 来由：TitleBar 控件簇的浮层共用 `.theme-popover` 的几何，而那个类里的 `right: 12px`
// 只对贴着视口右缘的按钮成立 —— 铃铛不在那个位置，浮层因此整整偏出一个面板宽。同一个坑
// 当年各修各的修过三遍（Accent / Surface 各写一份「开弹时按按钮右缘算 right」，Theme 写死
// 88px 魔数，铃铛干脆没修），所以收敛到这里。那三枚 picker 已随 08-27 dogfood 修正批退役，
// 现存消费方只剩通知铃铛（dogfood 轮4 起整簇迁到顶栏左段，本 hook 按触发器实测坐标算，
// 不受落位影响）—— 保留它是因为簇里再加浮层时同一个坑会原样复现。
//
// 只做「右对齐触发器 + 视口收口」这一种形态：**纵向落点仍归 CSS**（`.theme-popover` 的
// top，右簇浮层共用同一条水平线是 chrome 的既定观感），本 hook 不接管，只按浮层的实际
// 落点算出到视口底还剩多少高度，供高面板（通知面板）收口用。
//
// 需要「跟随任意页内按钮落到下方」的场景用 `useAnchoredPosition`（left/width 口径，两个
// 工具栏浮层在用），两者形态不同，不合并。

import { useLayoutEffect, useState } from 'react'

export interface AnchoredPopoverPlacement {
  /** 视口右缘到浮层右缘的距离，直接写进 `style.right`（配 `position: fixed`）。 */
  right: number
  /** 浮层顶边到视口底的可用高度（已扣 gutter）；调用方按需接到 `maxHeight`。 */
  maxHeight: number
}

export interface AnchoredPopoverOptions {
  /** 浮层与视口边缘的最小留白，默认 8px。 */
  gutter?: number
}

const DEFAULT_GUTTER = 8
/** 视口极矮时也别把浮层压成一条缝 —— 宁可露出去一点也要能用（同 useAnchoredPosition）。 */
const MIN_USABLE_HEIGHT = 160

export function useAnchoredPopover(
  triggerRef: React.RefObject<HTMLElement | null>,
  popoverRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  options: AnchoredPopoverOptions = {}
): AnchoredPopoverPlacement | null {
  const { gutter = DEFAULT_GUTTER } = options
  const [placement, setPlacement] = useState<AnchoredPopoverPlacement | null>(null)

  useLayoutEffect(() => {
    if (!active) {
      setPlacement(null)
      return
    }
    let raf = 0
    const measure = (): void => {
      raf = 0
      const trigger = triggerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) {
        // 触发器被响应式布局换掉 / 浮层还没挂：收成 null，调用方回落 CSS 兜底几何，
        // 而不是把上一次的坐标留在一个已经不存在的按钮旁边。
        setPlacement(null)
        return
      }
      const anchor = trigger.getBoundingClientRect()
      // 🔴 浮层这一侧用 offsetWidth/offsetTop 而**不是** getBoundingClientRect()：进场动画
      // 此刻正把 scale/translate 挂在浮层上，rect 是变换**后**的几何（motion 测量陷阱同款）。
      // offset* 是纯布局量，transform 不影响它。
      const width = popover.offsetWidth
      const top = popover.offsetTop
      const vw = window.innerWidth
      const vh = window.innerHeight
      // 右对齐触发器；再夹一次，保证浮层左缘不越出视口（窄窗口下宽面板）。
      const maxRight = Math.max(gutter, vw - gutter - width)
      const right = Math.round(Math.min(Math.max(vw - anchor.right, gutter), maxRight))
      const maxHeight = Math.max(MIN_USABLE_HEIGHT, Math.round(vh - top - gutter))
      // 值没变就还回原对象：scroll 是 capture 监听，页面里任何一处滚动都会走到这里，
      // 每帧换一个新对象等于每帧重渲染整个浮层子树。
      setPlacement((prev) =>
        prev && prev.right === right && prev.maxHeight === maxHeight ? prev : { right, maxHeight }
      )
    }
    measure()
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', schedule)
    // capture：外层容器的滚动不冒泡到 window，chrome 浮层要跟着触发器走。
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [active, triggerRef, popoverRef, gutter])

  return placement
}
