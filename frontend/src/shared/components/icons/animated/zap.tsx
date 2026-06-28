// lucide-animated · zap（闪电路径从头绘入）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      opacity: { duration: 0.1 }
    }
  }
}

export function ZapIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={PATH}
        d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"
      />
    </IconShell>
  )
}
