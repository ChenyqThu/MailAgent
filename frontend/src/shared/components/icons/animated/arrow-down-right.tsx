// lucide-animated · arrow-down-right。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [0, -3, 0],
    translateY: [0, -3, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SHAFT_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0, scale: 1 },
  animate: {
    translateX: [0, -3, 0],
    translateY: [0, -3, 0],
    scale: [1, 0.85, 1],
    originX: 1,
    originY: 1,
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function ArrowDownRightIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M7 7 L17 17" variants={SHAFT_VARIANTS} />
      <motion.path d="M17 7v10H7" variants={HEAD_VARIANTS} />
      <motion.path d="M17 17 L10 17" variants={HEAD_VARIANTS} />
    </IconShell>
  )
}
