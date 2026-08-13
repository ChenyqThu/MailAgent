// reactbits BorderGlow — 官方 TS-CSS 源码（reactbits.dev/r/BorderGlow-TS-CSS）逐字段移植：
// mesh-gradient 彩虹边框 ::before + 近边背景填充 ::after + edge-light 辉光环 + pointer 跟随 + intro。
// 逻辑（parseHSL / buildGlowVars / buildGradientVars / pointer 算法 / animateValue / intro 四段）与
// 官方一致；样式在 index.css（.rb-border-glow-card / .rb-edge-light / .rb-border-glow-inner）。
//
// 仅 6 处适配（守项目红线，不改视觉）：
//  ① CSS 变量 / 类名加 rb- 前缀（防与全局 CSS 撞。同前缀的 FAB `.rb-star-border` 已于 0813
//     随 FAB 换主 agent 头像退役 —— 那套 conic 环绑死圆形，异形头像下改成了沿轮廓描边）；
//  ② 去 `import './BorderGlow.css'` —— 样式合进三端共享的 index.css；
//  ③ backgroundColor 默认 #120F17 → app token rgb(var(--ink-2))（跟随明暗主题）；
//  ④ reduce 下不挂 pointer / 不播 intro（CSS 也隐藏辉光层）；
//  ⑤ named export（项目惯例 import { BorderGlow }）；
//  ⑥ 文件级 no-raw-hex 豁免：colors/glowColor 是官方固有视觉资产（紫粉蓝霓虹 + 暖黄辉光），非设计 token。
/* eslint-disable mailagent/no-raw-hex -- reactbits 官方移植：mesh/glow 颜色是组件固有视觉，非项目 token。 */
import { useRef, useCallback, useEffect, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'

import { cn } from '@shared/lib/cn'

interface BorderGlowProps {
  children?: ReactNode
  className?: string
  edgeSensitivity?: number
  glowColor?: string
  backgroundColor?: string
  borderRadius?: number
  glowRadius?: number
  glowIntensity?: number
  coneSpread?: number
  animated?: boolean
  colors?: string[]
  fillOpacity?: number
}

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/)
  if (!match) return { h: 40, s: 80, l: 80 }
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) }
}

function buildGlowVars(glowColor: string, intensity: number): Record<string, string> {
  const { h, s, l } = parseHSL(glowColor)
  const base = `${h}deg ${s}% ${l}%`
  const opacities = [100, 60, 50, 40, 30, 20, 10]
  const keys = ['', '-60', '-50', '-40', '-30', '-20', '-10']
  const vars: Record<string, string> = {}
  for (let i = 0; i < opacities.length; i++) {
    vars[`--rb-glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`
  }
  return vars
}

const GRADIENT_POSITIONS = [
  '80% 55%',
  '69% 34%',
  '8% 6%',
  '41% 38%',
  '86% 85%',
  '82% 18%',
  '51% 4%'
]
const GRADIENT_KEYS = [
  '--rb-gradient-one',
  '--rb-gradient-two',
  '--rb-gradient-three',
  '--rb-gradient-four',
  '--rb-gradient-five',
  '--rb-gradient-six',
  '--rb-gradient-seven'
]
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1]

function buildGradientVars(colors: string[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)]
    vars[GRADIENT_KEYS[i]] =
      `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`
  }
  vars['--rb-gradient-base'] = `linear-gradient(${colors[0]} 0 100%)`
  return vars
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3)
}
function easeInCubic(x: number): number {
  return x * x * x
}

interface AnimateOpts {
  start?: number
  end?: number
  duration?: number
  delay?: number
  ease?: (t: number) => number
  onUpdate: (v: number) => void
  onEnd?: () => void
}

function animateValue({
  start = 0,
  end = 100,
  duration = 1000,
  delay = 0,
  ease = easeOutCubic,
  onUpdate,
  onEnd
}: AnimateOpts): void {
  const t0 = performance.now() + delay
  function tick(): void {
    const elapsed = performance.now() - t0
    const t = Math.min(elapsed / duration, 1)
    onUpdate(start + (end - start) * ease(t))
    if (t < 1) requestAnimationFrame(tick)
    else if (onEnd) onEnd()
  }
  setTimeout(() => requestAnimationFrame(tick), delay)
}

export function BorderGlow({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '40 80 80',
  backgroundColor = 'rgb(var(--ink-2))',
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1.0,
  coneSpread = 25,
  animated = false,
  colors = ['#c084fc', '#f472b6', '#38bdf8'],
  fillOpacity = 0.5
}: BorderGlowProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()

  const getCenterOfElement = useCallback((el: HTMLElement) => {
    const { width, height } = el.getBoundingClientRect()
    return [width / 2, height / 2]
  }, [])

  const getEdgeProximity = useCallback(
    (el: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(el)
      const dx = x - cx
      const dy = y - cy
      let kx = Infinity
      let ky = Infinity
      if (dx !== 0) kx = cx / Math.abs(dx)
      if (dy !== 0) ky = cy / Math.abs(dy)
      return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1)
    },
    [getCenterOfElement]
  )

  const getCursorAngle = useCallback(
    (el: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(el)
      const dx = x - cx
      const dy = y - cy
      if (dx === 0 && dy === 0) return 0
      const radians = Math.atan2(dy, dx)
      let degrees = radians * (180 / Math.PI) + 90
      if (degrees < 0) degrees += 360
      return degrees
    },
    [getCenterOfElement]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const card = cardRef.current
      if (!card) return
      const rect = card.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const edge = getEdgeProximity(card, x, y)
      const angle = getCursorAngle(card, x, y)
      card.style.setProperty('--rb-edge-proximity', `${(edge * 100).toFixed(3)}`)
      card.style.setProperty('--rb-cursor-angle', `${angle.toFixed(3)}deg`)
    },
    [getEdgeProximity, getCursorAngle]
  )

  useEffect(() => {
    if (!animated || reduce || !cardRef.current) return
    const card = cardRef.current
    const angleStart = 110
    const angleEnd = 465
    card.classList.add('rb-sweep-active')
    card.style.setProperty('--rb-cursor-angle', `${angleStart}deg`)

    animateValue({
      duration: 500,
      onUpdate: (v) => card.style.setProperty('--rb-edge-proximity', `${v}`)
    })
    animateValue({
      ease: easeInCubic,
      duration: 1500,
      end: 50,
      onUpdate: (v) => {
        card.style.setProperty(
          '--rb-cursor-angle',
          `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`
        )
      }
    })
    animateValue({
      ease: easeOutCubic,
      delay: 1500,
      duration: 2250,
      start: 50,
      end: 100,
      onUpdate: (v) => {
        card.style.setProperty(
          '--rb-cursor-angle',
          `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`
        )
      }
    })
    animateValue({
      ease: easeInCubic,
      delay: 2500,
      duration: 1500,
      start: 100,
      end: 0,
      onUpdate: (v) => card.style.setProperty('--rb-edge-proximity', `${v}`),
      onEnd: () => card.classList.remove('rb-sweep-active')
    })
  }, [animated, reduce])

  const glowVars = buildGlowVars(glowColor, glowIntensity)

  return (
    <div
      ref={cardRef}
      onPointerMove={reduce ? undefined : handlePointerMove}
      className={cn('rb-border-glow-card', className)}
      style={
        {
          '--rb-card-bg': backgroundColor,
          '--rb-edge-sensitivity': edgeSensitivity,
          '--rb-border-radius': `${borderRadius}px`,
          '--rb-glow-padding': `${glowRadius}px`,
          '--rb-cone-spread': coneSpread,
          '--rb-fill-opacity': fillOpacity,
          ...glowVars,
          ...buildGradientVars(colors)
        } as React.CSSProperties
      }
    >
      <span className="rb-edge-light" aria-hidden="true" />
      <div className="rb-border-glow-inner">{children}</div>
    </div>
  )
}
