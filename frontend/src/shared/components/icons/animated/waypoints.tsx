// lucide-animated · waypoints。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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
      delay: 0.15 * custom,
      opacity: { delay: 0.1 * custom, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function WaypointsIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle custom={0} cx="12" cy="4.5" r="2.5" variants={VARIANTS} />
      <motion.path custom={1} d="m10.2 6.3-3.9 3.9" variants={VARIANTS} />
      <motion.circle custom={0} cx="4.5" cy="12" r="2.5" variants={VARIANTS} />
      <motion.path custom={2} d="M7 12h10" variants={VARIANTS} />
      <motion.circle custom={0} cx="19.5" cy="12" r="2.5" variants={VARIANTS} />
      <motion.path custom={3} d="m13.8 17.7 3.9-3.9" variants={VARIANTS} />
      <motion.circle custom={0} cx="12" cy="19.5" r="2.5" variants={VARIANTS} />
    </IconShell>
  )
}
