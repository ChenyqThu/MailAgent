// lucide-animated · tornado。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: (custom: number) => ({
    x: [0, custom * 1, 0],
    opacity: 1,
    transition: {
      x: { duration: 0.6, ease: ICON_EASE, delay: custom * 0.1, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function TornadoIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={1} d="M21 4H3" variants={PATH_VARIANTS} />
      <motion.path custom={2} d="M18 8H6" variants={PATH_VARIANTS} />
      <motion.path custom={3} d="M19 12H9" variants={PATH_VARIANTS} />
      <motion.path custom={4} d="M16 16h-6" variants={PATH_VARIANTS} />
      <motion.path custom={5} d="M11 20H9" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
