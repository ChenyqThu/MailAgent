// lucide-animated · user-plus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PLUS_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scale: [0, 1.15, 1],
    rotate: [-90, 0, 0],
    opacity: [0, 1, 1],
    transition: {
      delay: 0.25,
      duration: 0.45,
      ease: ICON_EASE,
      times: [0, 0.7, 1],
      type: 'tween' as const
    }
  }
}

export function UserPlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <motion.g style={{ transformOrigin: '19px 11px' }} variants={PLUS_VARIANTS}>
        <line x1="19" x2="19" y1="8" y2="14" />
        <line x1="22" x2="16" y1="11" y2="11" />
      </motion.g>
    </IconShell>
  )
}
