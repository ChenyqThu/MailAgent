// useAnchoredPosition — 把一个 portal 到 body 的浮层钉在某个锚点元素下方。
//
// 存在的理由（0812 dogfood 的 P0）：邮件详情工具栏那条 header 为了窄宽下不横向溢出挂了
// `overflow-x-auto`，而按 CSS Overflow 3「一轴是 auto 时另一轴的 visible 计算成 auto」，
// 这个 44px 高的 header 就变成了**两个方向**的裁剪容器 —— header 内所有 `absolute` 浮层
// （事项弹层 / 撰写下拉）从此只剩几像素露在框内，点了等于没反应。
//
// 解法不是回退 `overflow-x-auto`（那是窄宽溢出的正确修复），而是让浮层 portal 到 body、
// 与祖先 overflow 彻底解耦；位置就由本 hook 按锚点的实测 rect 算出来（position: fixed）。
//
// 只做「下方对齐 + 视口夹取」这一种形态 —— 两个调用点都只需要这个，不引入 floating-ui。

import { useLayoutEffect, useState } from 'react'

export interface AnchoredPosition {
  /** viewport 坐标，直接写进 `style.top`（配 `position: fixed`）。 */
  top: number
  left: number
  /** 视口底部剩余空间夹取后的可用高度；调用方按需接到滚动区的 maxHeight。 */
  maxHeight: number
}

export interface AnchoredPositionOptions {
  /** 浮层宽度（px）。用于 `align:'end'` 的右对齐与右边界夹取。 */
  width: number
  /** 'start' = 左缘对齐锚点左缘；'end' = 右缘对齐锚点右缘。默认 'start'。 */
  align?: 'start' | 'end'
  /** 锚点底边与浮层顶边的间距，默认 6px。 */
  gap?: number
  /** 浮层自身的高度上限；视口不够时再按视口收口。默认不限。 */
  maxHeight?: number
}

const VIEWPORT_MARGIN = 8
/** 视口极矮时也别把浮层压成一条缝 —— 宁可露出去一点也要能用。 */
const MIN_USABLE_HEIGHT = 160

export function useAnchoredPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  options: AnchoredPositionOptions
): AnchoredPosition | null {
  const { width, align = 'start', gap = 6, maxHeight = Number.POSITIVE_INFINITY } = options
  const [position, setPosition] = useState<AnchoredPosition | null>(null)

  useLayoutEffect(() => {
    if (!active) {
      setPosition(null)
      return
    }
    let cancelled = false
    const measure = (): boolean => {
      const anchor = anchorRef.current
      if (!anchor) {
        // 🔴 浮层开着的时候锚点被响应式布局换掉 / 卸载了（0812 codex #7）：留着上一次的坐标 =
        // 浮层连同全屏遮罩停在一个已经不存在的按钮旁边。测不到就收位置（调用方据此不渲染），
        // 同 commit 挂载的那种"这一轮量不到"由下面的微任务补测兜住（那时 position 本就是 null）。
        setPosition(null)
        return false
      }
      const rect = anchor.getBoundingClientRect()
      const top = rect.bottom + gap
      const rightLimit = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
      const rawLeft = align === 'end' ? rect.right - width : rect.left
      setPosition({
        top,
        left: Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), rightLimit),
        maxHeight: Math.max(
          MIN_USABLE_HEIGHT,
          Math.min(maxHeight, window.innerHeight - top - VIEWPORT_MARGIN)
        )
      })
      return true
    }
    if (!measure()) {
      // 锚点与浮层在**同一次 commit** 里挂载时，锚点（父节点）的 ref 要等子树的 layout
      // effect 跑完才赋值（React 自底向上提交）→ 这一轮量不到。微任务里补测一次即可拿到，
      // 且仍在同一轮渲染批次内，用户看不到中间态。
      queueMicrotask(() => {
        if (!cancelled) measure()
      })
    }
    const onViewportChange = (): void => {
      measure()
    }
    window.addEventListener('resize', onViewportChange)
    // capture: 工具栏自身的横向滚动 / 外层容器滚动都要跟随，而 scroll 不冒泡到 window。
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      cancelled = true
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [active, anchorRef, align, gap, maxHeight, width])

  return position
}
