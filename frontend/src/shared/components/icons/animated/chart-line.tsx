// lucide-animated · chart-line（折线从左到右绘入）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      delay: 0.1,
      opacity: { delay: 0.1, duration: 0.1 }
    }
  }
}

export function ChartLineIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <motion.path variants={LINE} d="m7 13 3-3 4 4 5-5" />
    </IconShell>
  )
}
