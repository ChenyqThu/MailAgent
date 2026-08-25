// lucide-animated · accessibility。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1；variant 标签重命名。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLE_VARIANTS: Variants = {
  normal: { y: 0, x: 0 },
  animate: {
    y: [0, 1, -1, 0],
    x: [0, 1, -1, 0],
    transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
  }
}

const PRIMARY_GROUP_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, 5, -5, 0],
    transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SECONDARY_GROUP_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: -360,
    transition: { duration: 0.6, delay: 0.4, ease: ICON_EASE, type: 'tween' as const }
  }
}

const PATH_VARIANTS: Variants = {
  normal: { rotate: 0, d: 'M8 5 L5 8' },
  animate: {
    rotate: [0, -60, 0],
    d: ['M8 5 L5 8', 'M8 5 L4 9', 'M8 5 L5 8'],
    transition: { duration: 0.4, delay: 0.2, ease: ICON_EASE, type: 'tween' as const },
    transformOrigin: 'top right'
  }
}

export function AccessibilityIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle cx="16" cy="4" r="1" variants={CIRCLE_VARIANTS} />
      <motion.g variants={PRIMARY_GROUP_VARIANTS}>
        <path d="m18 19 1-7-6 1" />
        <path d="M8,5l5.5,3-2.4,3.5" />
        <motion.path d="M8 5 L5 8" variants={PATH_VARIANTS} />
      </motion.g>
      <motion.g variants={SECONDARY_GROUP_VARIANTS}>
        <path d="M4.2,14.5c-.8,2.6.7,5.4,3.3,6.2,1.2.4,2.4.3,3.6-.2" />
        <path d="M13.8,17.5c.8-2.6-.7-5.4-3.3-6.2-1.2-.4-2.4-.3-3.6.2" />
        <path d="M13,13.1c-.5-.7-1.1-1.2-1.9-1.6" />
      </motion.g>
    </IconShell>
  )
}
