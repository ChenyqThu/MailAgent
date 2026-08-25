// lucide-animated · satellite-dish。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SATELLITE_DISH_VARIANTS: Variants = {
  normal: { y: 0, rotate: 0 },
  animate: {
    y: [0, 1, 2, 0],
    rotate: [0, -15, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: i * 0.1 }
  })
}

export function SatelliteDishIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={SATELLITE_DISH_VARIANTS}>
      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" />
      <path d="m9 15 3-3" />
      <motion.path custom={1} d="M17 13a6 6 0 0 0-6-6" variants={PATH_VARIANTS} />
      <motion.path custom={2} d="M21 13A10 10 0 0 0 11 3" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
