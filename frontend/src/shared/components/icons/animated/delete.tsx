// lucide-animated · delete（退格键 hover 左抖 + ×号描入）。pqoqubbw delete.tsx 实为 trash；此处用 lucide delete（带×的退格键）路径，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SVG_VARIANTS: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, -2, 1, -1, 0],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      times: [0, 0.25, 0.5, 0.75, 1]
    }
  }
}

const CROSS_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.3,
      ease: ICON_EASE,
      delay: 0.1,
      opacity: { type: 'tween' as const, duration: 0.1, delay: 0.1 }
    }
  }
}

export function DeleteIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={SVG_VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.4, ease: ICON_EASE }}
    >
      <path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
      <motion.path variants={CROSS_VARIANTS} d="m12 9 6 6" />
      <motion.path variants={CROSS_VARIANTS} d="m18 9-6 6" />
    </IconShell>
  )
}
