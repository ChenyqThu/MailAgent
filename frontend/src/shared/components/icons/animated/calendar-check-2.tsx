// lucide-animated · calendar-check-2。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CHECK_VARIANTS: Variants = {
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

export function CalendarCheck2Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M21 14V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
      <path d="M3 10h18" />
      <motion.path
        d="m16 20 2 2 4-4"
        style={{ transformOrigin: 'center' }}
        variants={CHECK_VARIANTS}
      />
    </IconShell>
  )
}
