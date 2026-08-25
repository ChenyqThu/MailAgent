// lucide-animated · roller-coaster。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      delay: 0.1 * custom,
      opacity: { delay: 0.1 * custom, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function RollerCoasterIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M6 19V5" variants={VARIANTS} />
      <motion.path d="M10 19V6.8" variants={VARIANTS} />
      <motion.path d="M14 19v-7.8" variants={VARIANTS} />
      <motion.path d="M18 5v4" variants={VARIANTS} />
      <motion.path d="M18 19v-6" variants={VARIANTS} />
      <motion.path d="M22 19V9" variants={VARIANTS} />
      <motion.path
        custom={2}
        d="M2 19V9a4 4 0 0 1 4-4c2 0 4 1.33 6 4s4 4 6 4a4 4 0 1 0-3-6.65"
        variants={VARIANTS}
      />
    </IconShell>
  )
}
