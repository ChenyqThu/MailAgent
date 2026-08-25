// lucide-animated · cigarette-off。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIGARETTE_VARIANTS: Variants = {
  normal: { y: 0, opacity: 1 },
  animate: (custom: number) => ({
    y: -3,
    opacity: [0, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, delay: 0.2 * custom, type: 'tween' as const }
  })
}

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1 },
  animate: {
    pathLength: [0, 1],
    transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CigaretteOffIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M12 12H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h13" />
      <motion.path d="M18 8c0-2.5-2-2.5-2-5" variants={CIGARETTE_VARIANTS} />
      <motion.path d="m2 2 20 20" variants={PATH_VARIANTS} />
      <motion.path d="M21 12a1 1 0 0 1 1 1v2a1 1 0 0 1-.5.866" />
      <motion.path d="M22 8c0-2.5-2-2.5-2-5" variants={CIGARETTE_VARIANTS} />
      <path d="M7 12v4" />
    </IconShell>
  )
}
