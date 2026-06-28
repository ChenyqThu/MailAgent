// lucide-animated · map-pin-check（图钉上弹 + 勾号描入）。源 pqoqubbw/icons，改造：tween 保留 + ICON_EASE（§10）；去 forwardRef/div 外壳；svg 整体上弹 + motion.path 勾描入。
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

const CHECK_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.3,
      ease: ICON_EASE,
      delay: 0.3,
      opacity: { type: 'tween' as const, duration: 0.1, delay: 0.3 }
    }
  }
}

export function MapPinCheckIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={SVG_VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
    >
      <path d="M19.43 12.935c.357-.967.57-1.955.57-2.935a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32.197 32.197 0 0 0 .813-.728" />
      <circle cx="12" cy="10" r="3" />
      <motion.path variants={CHECK_VARIANTS} d="m16 18 2 2 4-4" />
    </IconShell>
  )
}
