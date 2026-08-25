// lucide-animated · meh。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
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
    scale: [1, 1.05, 0.98, 1.02],
    rotate: [0, 1, -1, 0],
    transition: { duration: 0.7, times: [0, 0.4, 0.7, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const mouthVariants: Variants = {
  normal: {
    scaleX: 1,
    y: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scaleX: [1, 1.2, 0.9, 1.1],
    y: [0, 0.5, -0.5, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.3, 0.6, 1],
      ease: ICON_EASE,
      delay: 0.1,
      type: 'tween' as const
    }
  }
}

const leftEyeVariants: Variants = {
  normal: {
    scale: 1,
    x: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.3, 1, 1.2],
    x: [0, -0.3, 0.3, 0],
    transition: { duration: 0.5, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const rightEyeVariants: Variants = {
  normal: {
    scale: 1,
    x: 0,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.3, 1, 1.2],
    x: [0, 0.3, -0.3, 0],
    transition: { duration: 0.5, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function MehIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <circle cx="12" cy="12" r="10" />
      <motion.line variants={mouthVariants} x1="8" x2="16" y1="15" y2="15" />
      <motion.line variants={leftEyeVariants} x1="9" x2="9.01" y1="9" y2="9" />
      <motion.line variants={rightEyeVariants} x1="15" x2="15.01" y1="9" y2="9" />
    </IconShell>
  )
}
