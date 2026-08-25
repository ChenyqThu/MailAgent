// lucide-animated · laugh。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const faceVariants: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    strokeWidth: 2,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.15, 1, 1.1, 1.05],
    rotate: [0, 3, -2, 3, 0],
    strokeWidth: [2, 2.5, 2.5, 2.5, 2],
    transition: {
      duration: 0.6,
      times: [0, 0.2, 0.4, 0.6, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

const mouthVariants: Variants = {
  normal: {
    d: 'M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z',
    pathLength: 1,
    strokeWidth: 2,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    d: 'M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z',
    pathLength: [0.7, 1, 1],
    strokeWidth: 2.5,
    scaleY: [1, 1.2, 1.1],
    y: [0, 0.5, 0.3],
    transition: { duration: 0.6, times: [0, 0.5, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const eyeVariants: Variants = {
  normal: {
    scale: 1,
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [1, 1.3, 1, 1.7],
    opacity: [1, 1, 1, 1],
    transition: { duration: 0.6, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function LaughIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <circle cx="12" cy="12" r="10" />
      <motion.path variants={mouthVariants} />
      <motion.line variants={eyeVariants} x1="9" x2="9.01" y1="9" y2="9" />
      <motion.line variants={eyeVariants} x1="15" x2="15.01" y1="9" y2="9" />
    </IconShell>
  )
}
