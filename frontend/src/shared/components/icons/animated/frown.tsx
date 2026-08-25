// lucide-animated · frown。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const faceVariants: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.15, 1.05, 1.08],
    rotate: [0, -2, 2, 0],
    transition: { duration: 0.8, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const mouthVariants: Variants = {
  normal: {
    d: 'M16 16s-1.5-2-4-2-4 2-4 2',
    pathLength: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    d: 'M16 17s-1.5-2.5-4-2.5-4 2.5-4 2.5',
    pathLength: [0.3, 1, 1],
    transition: {
      d: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const },
      pathLength: { duration: 0.5, times: [0, 0.5, 1], ease: ICON_EASE, type: 'tween' as const },
      delay: 0.1,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

const leftEyeVariants: Variants = {
  normal: {
    scale: 1,
    y: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.3, 0.9, 1.1],
    y: [0, -0.5, 0.3, 0],
    transition: { duration: 0.6, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const rightEyeVariants: Variants = {
  normal: {
    scale: 1,
    y: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 0.9, 1.3, 1.1],
    y: [0, -0.5, 0.3, 0],
    transition: { duration: 0.6, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function FrownIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <circle cx="12" cy="12" r="10" />
      <motion.path d="M16 16s-1.5-2-4-2-4 2-4 2" variants={mouthVariants} />
      <motion.line variants={leftEyeVariants} x1="9" x2="9.01" y1="9" y2="9" />
      <motion.line variants={rightEyeVariants} x1="15" x2="15.01" y1="9" y2="9" />
    </IconShell>
  )
}
