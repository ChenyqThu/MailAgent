// lucide-animated · calendar-check（勾号 hover 绘入）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CHECK: Variants = {
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
      opacity: { duration: 0.1 }
    }
  }
}

export function CalendarCheckIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect height="18" rx="2" width="18" x="3" y="4" />
      <path d="M3 10h18" />
      <motion.path variants={CHECK} d="m9 16 2 2 4-4" style={{ transformOrigin: 'center' }} />
    </IconShell>
  )
}
