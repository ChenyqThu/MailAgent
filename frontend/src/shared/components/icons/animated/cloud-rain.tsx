// lucide-animated · cloud-rain。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RAIN_VARIANTS: Variants = {
  animate: {
    transition: { staggerChildren: 0.2, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const RAIN_CHILD_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0.2, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CloudRainIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <motion.g variants={RAIN_VARIANTS}>
        <motion.path d="M16 14v6" variants={RAIN_CHILD_VARIANTS} />
        <motion.path d="M8 14v6" variants={RAIN_CHILD_VARIANTS} />
        <motion.path d="M12 16v6" variants={RAIN_CHILD_VARIANTS} />
      </motion.g>
    </IconShell>
  )
}
