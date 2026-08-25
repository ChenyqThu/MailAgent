// lucide-animated · coffee。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { y: 0, opacity: 1 },
  animate: (custom: number) => ({
    y: -3,
    opacity: [0, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, delay: 0.2 * custom, type: 'tween' as const }
  })
}

export function CoffeeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.path custom={0.2} d="M10 2v2" variants={PATH_VARIANTS} />
      <motion.path custom={0.4} d="M14 2v2" variants={PATH_VARIANTS} />
      <motion.path custom={0} d="M6 2v2" variants={PATH_VARIANTS} />
      <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
    </IconShell>
  )
}
