// lucide-animated · server。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×2；时长收敛 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TOP_RECT_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, 12, 12, 0],
    transition: {
      duration: 0.6,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 1],
      type: 'tween' as const
    }
  }
}

const BOTTOM_RECT_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, -12, -12, 0],
    transition: {
      duration: 0.6,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 1],
      type: 'tween' as const
    }
  }
}

export function ServerIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g variants={TOP_RECT_VARIANTS}>
        <rect height="8" rx="2" ry="2" width="20" x="2" y="2" />
        <line x1="6" x2="10" y1="6" y2="6" />
      </motion.g>
      <motion.g variants={BOTTOM_RECT_VARIANTS}>
        <rect height="8" rx="2" ry="2" width="20" x="2" y="14" />
        <line x1="6" x2="10" y1="18" y2="18" />
      </motion.g>
    </IconShell>
  )
}
