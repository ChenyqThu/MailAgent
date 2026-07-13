import { useReducedMotion } from 'motion/react'
import { useState, useEffect, useRef } from 'react'

import Strands from './Strands'

/**
 * Token-bridge wrapper around the reactbits Strands WebGL backdrop.
 *
 * - Reads CSS custom-property color channels (project-native "r g b" format) from the root element
 *   so the silk strands follow the active accent/theme without coupling to any hard-coded value.
 * - Observes `data-accent` and `data-theme` attribute mutations → re-reads colors live; Strands'
 *   per-frame palette rebuild picks them up without re-initialising WebGL.
 * - Respects prefers-reduced-motion: returns null (no WebGL canvas mounted at all).
 * - Intentionally subdued defaults so the backdrop stays atmospheric, not distracting.
 */

// dogfood：调色板 = 当前强调色（固定）+ 从其余 8 个主题色随机选 3（用户：不固定白、主色固定、其余随机）。当前色读
// --c-accent（准确跟随明暗 + 9 强调色切换）；其余主题色 JS 读不到（CSS 只暴露当前 --c-accent），故镜像
// 一份全集（明暗各一套）。🔴 镜像自 index.css accent override（暗 = :root[data-accent]；亮 =
// :root[data-theme='light'][data-accent]）—— 那边改强调色 RGB 需同步这里。不读 --ink-fg-3（暗色下是浅灰
// → 丝线偏白「看不出颜色」）。
const ACCENT_SET_DARK: Record<string, string> = {
  coral: '248 138 125',
  cobalt: '126 173 255',
  teal: '55 199 174',
  rose: '241 136 175',
  slate: '158 176 196',
  olive: '163 185 108',
  amber: '223 160 60',
  emerald: '105 198 127',
  violet: '187 153 246'
}
const ACCENT_SET_LIGHT: Record<string, string> = {
  coral: '164 60 51',
  cobalt: '52 95 178',
  teal: '0 117 95',
  rose: '158 58 100',
  slate: '82 101 122',
  olive: '89 108 23',
  amber: '134 89 1',
  emerald: '0 117 49',
  violet: '113 76 166'
}

function readTokenColors(): string[] {
  const root = document.documentElement
  const current =
    getComputedStyle(root).getPropertyValue('--c-accent').trim() || ACCENT_SET_DARK.coral
  const isLight = root.getAttribute('data-theme') === 'light'
  const accentKey = root.getAttribute('data-accent') ?? 'coral'
  const set = isLight ? ACCENT_SET_LIGHT : ACCENT_SET_DARK
  // 其余 5 个主题色 Fisher-Yates 洗牌取前 3 作随机配色（每次 mount / 切主题时重选）
  const others = Object.keys(set).filter((k) => k !== accentKey)
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[others[i], others[j]] = [others[j], others[i]]
  }
  const pick3 = others.slice(0, 3).map((k) => set[k])
  // 当前强调色（固定）+ 随机 3 个其他主题色（共 4 色，配 count=4；不再固定白）
  return [current, ...pick3]
}

export function AgentStrandsBackdrop(): React.JSX.Element | null {
  const reducedMotion = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  const [colors, setColors] = useState<string[]>(() => {
    // Safe initialiser: runs client-side only (Electron renderer), never SSR
    if (typeof document !== 'undefined') return readTokenColors()
    return ['180 180 180']
  })

  useEffect(() => {
    // The lazy useState initializer already called readTokenColors() on mount.
    // Only re-read when the accent or theme attribute changes (MutationObserver callback).
    const observer = new MutationObserver(() => {
      setColors(readTokenColors())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-accent', 'data-theme']
    })
    return () => observer.disconnect()
  }, [])

  // dogfood：只在容器真正可见时挂 WebGL canvas。app 里 agent 视图 + 邮件正文浮窗（minimised 时
  // display:none 但 DOM 仍在）等多个 AgentThread 实例都渲染本组件 → 不 guard 就同时挂多个 strands
  // canvas（用户反馈「3 个 strands」）。IntersectionObserver 检测 ref 可见性：display:none / 滚出视口的
  // 实例 isIntersecting=false → 不挂 Strands（顺带省持续 GPU）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  if (reducedMotion) return null

  return (
    <div ref={ref} className="absolute inset-0">
      {visible && (
        <Strands
          colors={colors}
          className="pointer-events-none"
          count={4}
          speed={0.25}
          amplitude={0.8}
          waviness={1.2}
          thickness={0.7}
          glow={1.5}
          taper={2}
          spread={2}
          intensity={0.8}
          saturation={1.2}
          opacity={1}
          scale={1.2}
          hueShift={1}
        />
      )}
    </div>
  )
}
