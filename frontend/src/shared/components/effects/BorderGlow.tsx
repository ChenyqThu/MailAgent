// reactbits BorderGlow（精简移植）— pointer 跟随的边缘辉光环 + 挂载时 intro sweep。
// 落点 AI 输入框（AgentComposer），三端共享（effects/ 组件 + index.css 样式）。
//
// 改造（守红线 + 对齐 app 调性，详见 motion-gsap §10）：
//  · 原组件的彩虹 mesh-gradient border 去掉，辉光统一走单色 --c-accent token（跟随 6 强调色 +
//    明暗），组件内无裸 hex；glow box-shadow / conic mask 全在 index.css（.css 豁免 no-raw-hex）。
//  · intro sweep 用手写单 rAF 缓动（easeOutCubic/InCubic/InOut，非 motion spring）守 §8；
//    reduce 不挂 pointer 监听、不播 intro，CSS 直接隐藏辉光层（等价无 glow，退回 shell 自身描边）。
//  · pointer 只 setProperty 两个 CSS 变量（--rb-cursor-angle / --rb-edge-proximity），零 React
//    re-render（高频 pointermove 安全）。卸载 cancelAnimationFrame 防泄漏。
import { useCallback, useEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'

import { cn } from '@shared/lib/cn'

const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3)
const easeInCubic = (x: number): number => x * x * x
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

interface BorderGlowProps {
  children: React.ReactNode
  className?: string
  /** 指针多靠近边缘才点亮辉光（0-100，越大越难触发）。 */
  edgeSensitivity?: number
  /** 辉光整体不透明度乘子（0.1-3）。用户指定 0.5。 */
  glowIntensity?: number
  /** 圆角 px，须与被包裹 shell 的圆角一致（composer = rounded-2xl = 16）。 */
  borderRadius?: number
  /** 外发光向外延伸 px。 */
  glowRadius?: number
  /** 挂载时播一次 intro sweep（辉光绕一圈淡入淡出）。 */
  animated?: boolean
}

export function BorderGlow({
  children,
  className,
  edgeSensitivity = 30,
  glowIntensity = 0.5,
  borderRadius = 16,
  glowRadius = 22,
  animated = false
}: BorderGlowProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()

  // 指针位置 → 边缘贴近度(0 中心 / 1 边缘) + 指针角度（conic mask 只点亮指针所在弧段）。
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const card = ref.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const dx = e.clientX - rect.left - cx
    const dy = e.clientY - rect.top - cy
    const edge = Math.min(Math.max(Math.max(Math.abs(dx) / cx, Math.abs(dy) / cy), 0), 1)
    let deg = 0
    if (dx !== 0 || dy !== 0) {
      deg = Math.atan2(dy, dx) * (180 / Math.PI) + 90
      if (deg < 0) deg += 360
    }
    card.style.setProperty('--rb-edge-proximity', (edge * 100).toFixed(2))
    card.style.setProperty('--rb-cursor-angle', `${deg.toFixed(1)}deg`)
  }, [])

  // intro sweep：单 rAF 按 elapsed 推 angle(110→465 扫一圈余) + proximity(淡入→保持→淡出)。
  useEffect(() => {
    if (!animated || reduce) return
    const card = ref.current
    if (!card) return
    card.classList.add('rb-sweep-active')
    let raf = 0
    let t0 = 0
    const DUR = 4000
    const tick = (now: number): void => {
      if (!t0) t0 = now
      const e = now - t0
      const angle = 110 + 355 * easeInOut(Math.min(e / 3750, 1))
      const prox =
        e < 500
          ? 100 * easeOutCubic(e / 500)
          : e < 2500
            ? 100
            : 100 * (1 - easeInCubic(Math.min((e - 2500) / 1500, 1)))
      card.style.setProperty('--rb-cursor-angle', `${angle.toFixed(1)}deg`)
      card.style.setProperty('--rb-edge-proximity', prox.toFixed(2))
      if (e < DUR) raf = requestAnimationFrame(tick)
      else {
        card.classList.remove('rb-sweep-active')
        card.style.setProperty('--rb-edge-proximity', '0')
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      card.classList.remove('rb-sweep-active')
    }
  }, [animated, reduce])

  return (
    <div
      ref={ref}
      onPointerMove={reduce ? undefined : handlePointerMove}
      className={cn('rb-border-glow-card', className)}
      style={
        {
          '--rb-radius': `${borderRadius}px`,
          '--rb-glow-pad': `${glowRadius}px`,
          '--rb-edge-sens': edgeSensitivity,
          '--rb-glow-intensity': glowIntensity
        } as React.CSSProperties
      }
    >
      <span className="rb-edge-light" aria-hidden="true" />
      {children}
    </div>
  )
}
