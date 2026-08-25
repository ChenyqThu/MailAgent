// lucide-animated · square-activity。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

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

const SQUARE_VARIANTS: Variants = {
  normal: { transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE } },
  animate: { transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const } }
}

export function SquareActivityIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect height="18" rx="2" variants={SQUARE_VARIANTS} width="18" x="3" y="3" />
      <motion.path d="M17 12h-2l-2 5-2-10-2 5H7" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
