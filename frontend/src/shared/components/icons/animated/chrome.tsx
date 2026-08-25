// lucide-animated · chrome。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function ChromeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <motion.circle custom={0} cx="12" cy="12" r="4" variants={VARIANTS} />
      <motion.line custom={3} variants={VARIANTS} x1="21.17" x2="12" y1="8" y2="8" />
      <motion.line custom={3} variants={VARIANTS} x1="3.95" x2="8.54" y1="6.06" y2="14" />
      <motion.line custom={3} variants={VARIANTS} x1="10.88" x2="15.46" y1="21.94" y2="14" />
    </IconShell>
  )
}
