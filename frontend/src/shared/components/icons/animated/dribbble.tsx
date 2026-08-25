// lucide-animated · dribbble。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLE_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      duration: 0.6,
      ease: ICON_EASE,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const
    }
  }
}

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      duration: 0.6,
      ease: ICON_EASE,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const
    }
  }
}

export function DribbbleIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle cx="12" cy="12" r="10" variants={CIRCLE_VARIANTS} />
      <motion.path d="M19.13 5.09C15.22 9.14 10 10.44 2.25 10.94" variants={PATH_VARIANTS} />
      <motion.path d="M21.75 12.84c-6.62-1.41-12.14 1-16.38 6.32" variants={PATH_VARIANTS} />
      <motion.path d="M8.56 2.75c4.37 6 6 9.42 8 17.72" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
