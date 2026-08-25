// lucide-animated · cpu。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }

const Y_VARIANTS: Variants = {
  normal: { scale: 1, rotate: 0, opacity: 1 },
  animate: { scaleY: [1, 1.5, 1], opacity: [1, 0.8, 1] }
}

const X_VARIANTS: Variants = {
  normal: { scale: 1, rotate: 0, opacity: 1 },
  animate: { scaleX: [1, 1.5, 1], opacity: [1, 0.8, 1] }
}

export function CpuIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="16" rx="2" width="16" x="4" y="4" />
      <rect height="6" rx="1" width="6" x="9" y="9" />
      <motion.path d="M15 2v2" transition={TRANSITION} variants={Y_VARIANTS} />
      <motion.path d="M15 20v2" transition={TRANSITION} variants={Y_VARIANTS} />
      <motion.path d="M2 15h2" transition={TRANSITION} variants={X_VARIANTS} />
      <motion.path d="M2 9h2" transition={TRANSITION} variants={X_VARIANTS} />
      <motion.path d="M20 15h2" transition={TRANSITION} variants={X_VARIANTS} />
      <motion.path d="M20 9h2" transition={TRANSITION} variants={X_VARIANTS} />
      <motion.path d="M9 2v2" transition={TRANSITION} variants={Y_VARIANTS} />
      <motion.path d="M9 20v2" transition={TRANSITION} variants={Y_VARIANTS} />
    </IconShell>
  )
}
