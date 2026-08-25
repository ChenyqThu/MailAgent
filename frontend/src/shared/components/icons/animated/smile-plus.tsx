// lucide-animated · smile-plus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const faceVariants: Variants = {
  normal: { scale: 1 },
  animate: { scale: 1.1, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } }
}

const plusVariants: Variants = {
  normal: { rotate: 0, scale: 1 },
  animate: {
    rotate: 90,
    scale: 1.2,
    transition: { type: 'tween' as const, delay: 0.1, duration: 0.4, ease: ICON_EASE }
  }
}

export function SmilePlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <path d="M22 11v1a10 10 0 1 1-9-10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" x2="9.01" y1="9" y2="9" />
      <line x1="15" x2="15.01" y1="9" y2="9" />
      <motion.path d="M16 5h6" variants={plusVariants} />
      <motion.path d="M19 2v6" variants={plusVariants} />
    </IconShell>
  )
}
