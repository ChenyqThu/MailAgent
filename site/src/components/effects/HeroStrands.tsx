import { useReducedMotion } from 'motion/react'
import { useState, useEffect } from 'react'

import Strands from './Strands'

/**
 * Token-bridge wrapper around the reactbits Strands WebGL backdrop for the Hero section.
 *
 * - Reads CSS custom-property color channels (project-native "r g b" format) from the root
 *   element so the strands follow the active accent/theme without hard-coded values.
 * - Observes `data-accent` and `data-theme` attribute mutations → re-reads colors live;
 *   Strands' per-frame palette rebuild picks them up without re-initialising WebGL.
 * - Respects prefers-reduced-motion: returns null (no WebGL canvas mounted at all).
 * - Intentionally subdued defaults so the backdrop stays atmospheric and Hero text stays
 *   clearly readable — rein in rather than overwhelm.
 */

const CSS_VARS = ['--c-accent', '--c-accent-hi', '--c-accent-dim'] as const

function readTokenColors(): string[] {
  const style = getComputedStyle(document.documentElement)
  return CSS_VARS.map((v) => {
    const val = style.getPropertyValue(v).trim()
    // Expect "r g b" channel triplet; fall through to neutral if absent
    return val || '180 180 180'
  })
}

export default function HeroStrands(): React.JSX.Element | null {
  const reducedMotion = useReducedMotion()

  const [colors, setColors] = useState<string[]>(() => {
    // Safe initialiser: runs client-side only (after hydration), never during SSR/prerender.
    if (typeof document !== 'undefined') return readTokenColors()
    return ['180 180 180']
  })

  useEffect(() => {
    // Re-read when the accent or theme attribute changes (MutationObserver callback).
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
      className="hero-strands"
      opacity={0.22}
      glow={1.6}
      speed={0.28}
      count={3}
      intensity={0.45}
      glass={false}
      amplitude={0.85}
    />
  )
}
