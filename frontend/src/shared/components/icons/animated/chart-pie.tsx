// lucide-animated · chart-pie（扇形切片 hover 弹出右上角）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SLICE: Variants = {
  normal: {
    translateX: 0,
    translateY: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    translateX: 1.1,
    translateY: -1.1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function ChartPieIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={SLICE}
        d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"
      />
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
    </IconShell>
  )
}
