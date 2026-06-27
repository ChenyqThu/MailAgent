import { useReducedMotion } from 'motion/react'
import { useState, useEffect } from 'react'

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

const CSS_VARS = ['--c-accent', '--c-ai', '--ink-fg-3'] as const

function readTokenColors(): string[] {
  const style = getComputedStyle(document.documentElement)
  return CSS_VARS.map((v) => {
    const val = style.getPropertyValue(v).trim()
    // Expect "r g b" channel triplet; fall through to neutral if absent
    return val || '180 180 180'
  })
}

export function AgentStrandsBackdrop(): React.JSX.Element | null {
  const reducedMotion = useReducedMotion()

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

  if (reducedMotion) return null

  return (
    <Strands
      colors={colors}
      className="pointer-events-none"
      opacity={0.42}
      glow={1.8}
      speed={0.3}
      count={3}
      intensity={0.5}
      glass={false}
      amplitude={0.9}
    />
  )
}
