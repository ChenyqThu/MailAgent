// lucide-animated · train-track。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = {
  duration: 0.3,
  opacity: { delay: 0.15 }
}

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      ...TRANSITION,
      delay: 0.1 * custom,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function TrainTrackIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 17 17 2" />
      <motion.path custom={4} d="m2 14 8 8" variants={VARIANTS} />
      <motion.path custom={3} d="m5 11 8 8" variants={VARIANTS} />
      <motion.path custom={2} d="m8 8 8 8" variants={VARIANTS} />
      <motion.path custom={1} d="m11 5 8 8" variants={VARIANTS} />
      <motion.path custom={0} d="m14 2 8 8" variants={VARIANTS} />
      <path d="M7 22 22 7" />
    </IconShell>
  )
}
