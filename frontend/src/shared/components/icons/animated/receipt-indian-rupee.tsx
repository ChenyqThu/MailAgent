// lucide-animated · receipt-indian-rupee。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const INDIAN_RUPEE_MAIN_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
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
    transition: {
      duration: 0.6,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

const INDIAN_RUPEE_SECONDARY_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      delay: 0.5,
      duration: 0.4,
      opacity: { duration: 0.1, delay: 0.5, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function ReceiptIndianRupeeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z" />
      <motion.path d="M8 11h8" variants={INDIAN_RUPEE_SECONDARY_VARIANTS} />
      <motion.path d="M8 7h8" variants={INDIAN_RUPEE_SECONDARY_VARIANTS} />
      <motion.path d="M9 7a4 4 0 0 1 0 8H8l3 2" variants={INDIAN_RUPEE_MAIN_VARIANTS} />
    </IconShell>
  )
}
