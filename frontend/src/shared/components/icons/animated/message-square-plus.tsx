// lucide-animated · message-square-plus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PLUS_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const },
      opacity: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

const PLUS_HORIZONTAL_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { duration: 0.4, ease: ICON_EASE, delay: 0.2, type: 'tween' as const },
      opacity: { duration: 0.4, ease: ICON_EASE, delay: 0.2, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

export function MessageSquarePlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      <motion.path d="M12 8v6" variants={PLUS_VARIANTS} />
      <motion.path d="M9 11h6" variants={PLUS_HORIZONTAL_VARIANTS} />
    </IconShell>
  )
}
