// lucide-animated · route（两端圆点 + 路径依次绘入）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳；duration 0.7 收敛到 0.5。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLE: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: { type: 'tween' as const, duration: 0.3, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.3,
      ease: ICON_EASE,
      delay: 0.1,
      opacity: { delay: 0.1, duration: 0.1 }
    }
  }
}

const PATH: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    pathOffset: 0,
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      delay: 0.3,
      opacity: { delay: 0.3, duration: 0.1 }
    }
  }
}

export function RouteIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle variants={CIRCLE} cx="6" cy="19" r="3" />
      <motion.path variants={PATH} d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <motion.circle variants={CIRCLE} cx="18" cy="5" r="3" />
    </IconShell>
  )
}
