// lucide-animated · map-pin（图钉上弹 + 内圆描入）。源 pqoqubbw/icons，改造：tween 保留 + ICON_EASE（§10）；去 forwardRef/div 外壳；svg 整体上弹 + motion.circle 描入。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SVG_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, -4, -2],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      times: [0, 0.6, 1]
    }
  }
}

const CIRCLE_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1, pathOffset: 0 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [0.5, 0],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      delay: 0.3,
      opacity: { type: 'tween' as const, duration: 0.1, delay: 0.3 }
    }
  }
}

export function MapPinIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={SVG_VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
    >
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <motion.circle variants={CIRCLE_VARIANTS} cx="12" cy="10" r="3" />
    </IconShell>
  )
}
