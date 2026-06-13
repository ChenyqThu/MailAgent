// ShimmerDriver — 全局用 GSAP ticker 驱动所有 .think-shimmer 元素的 background-position。
//
// 为什么不靠 CSS animation：bg-clip-text + CSS @keyframes 动 background-position，在
// Electron 真实屏幕硬件 GPU 合成下，文字裁切层被光栅化成纹理后缓存、background-position
// 更新不触发重新光栅化（Chromium 已知 bug，CSS WG #9563）→ 文字在、却不流光。off-screen
// readback（capturePage）/ 软件渲染（playwright）每次重新光栅化、看起来正常，正是它们
// 掩盖了这个 bug。GSAP ticker 每帧写 inline style.backgroundPosition = 主线程 style
// mutation，强制 paint invalidation → 合成器必须重新光栅化 → 绕过缓存。
//
// 接管时把元素自身 CSS animation 设为 none（否则 animation 优先级覆盖 inline style，
// 且它正是失效的那个）；样式表里的 @keyframes 仍保留，作为「driver 未挂载」场景的兜底。
// reduce 时不驱动（CSS @media reduce 块已把 .think-shimmer 退化成静态实色，保证可读），
// cleanup 清除 inline style 让元素回到 CSS 控制（如运行时切换系统「减弱动态效果」）。
//
// 挂载点：App.tsx 根（electron renderer + web SPA 共用同一个 App），一次覆盖全部 6 处
// think-shimmer 用法（chat / 邮件详情 / 报告生成态）。getElementsByClassName 返回 live
// HTMLCollection，通常 0-2 个元素，每帧开销可忽略。
import { useEffect } from 'react'

import { gsap } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

// 与原 CSS @keyframes chat-think-shimmer 等价：background-position 200% → -200%
//（跨度 400%），周期 1.5s，linear，无限循环。
const PERIOD_SEC = 1.5

export function ShimmerDriver(): null {
  const reduce = useReducedMotion()
  useEffect(() => {
    if (reduce) return
    const tick = (time: number): void => {
      const els = document.getElementsByClassName('think-shimmer')
      if (els.length === 0) return
      const pos = 200 - ((time % PERIOD_SEC) / PERIOD_SEC) * 400
      const value = `${pos.toFixed(1)}% center`
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement
        if (el.style.animationName !== 'none') el.style.animationName = 'none'
        el.style.backgroundPosition = value
      }
    }
    gsap.ticker.add(tick)
    return () => {
      gsap.ticker.remove(tick)
      const els = document.getElementsByClassName('think-shimmer')
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement
        el.style.animationName = ''
        el.style.backgroundPosition = ''
      }
    }
  }, [reduce])
  return null
}
