// ShimmerText — 字形流光（一道高光扫过文字笔画，不是矩形背景扫）。
//
// 为什么是「双层 transform 抵消」而不是 bg-clip-text + background-position：
// 后者（含 GSAP 每帧写 inline backgroundPosition / motion 的 ShimmeringText）在
// Electron macOS 真实屏幕硬件 GPU 合成下，当元素处于合成层上下文（chat 列表等祖先
// 带 transform/will-change，虚拟滚动几乎必然）时，文字裁切层被光栅化成纹理缓存住，
// background-position / mask-position 更新都不重新光栅化 → 文字在却不流光（真机实测
// A/B/D 三种 background/mask 机制均失效）。唯一在合成层内保证逐帧重绘的是 transform
// （合成线程直接变换、不经 main-thread raster）。
//
// 结构：base 字形（静态可读）+ 一个 transform 横扫的窗口 win（mask 软边）露出 hi
// （高光色字形，与 base 完全重叠）。win 移动时 hi 反向 transform 抵消，使 hi 视觉
// 固定对齐 base，于是只有「win 扫到的字形部分」被高光照亮 = 字形流光。
//   win width = 40%（窗口宽 = 0.4×文字宽）；win 位移 -100%→250%（of winW）；
//   hi 位移 = -0.4×win 位移 = 40%→-100%（of hiW，hiW=文字宽）→ 精确抵消。
// 纯 CSS（两条反向 @keyframes，无 JS/rAF），任意文字宽自适应（百分比同源）。
import * as React from 'react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export function ShimmerText({
  text,
  neutral = false,
  className
}: {
  /** 要流光的文字（同时用于 base 与 hi 两层，保证字形一致）。 */
  text: string
  /** 中性高光（ink-fg 而非 AI 紫），用于非 AI 语境的纯加载文案。 */
  neutral?: boolean
  className?: string
}): React.ReactElement {
  const reduce = useReducedMotion()
  // reduce：静态实色文字（无动效），始终可读。
  if (reduce) {
    return (
      <span className={cn('shimmer-text-static', neutral && 'shimmer-neutral', className)}>
        {text}
      </span>
    )
  }
  return (
    <span className={cn('shimmer-text', neutral && 'shimmer-neutral', className)}>
      <span className="shimmer-text-base">{text}</span>
      <span className="shimmer-text-win" aria-hidden="true">
        <span className="shimmer-text-hi">{text}</span>
      </span>
    </span>
  )
}
