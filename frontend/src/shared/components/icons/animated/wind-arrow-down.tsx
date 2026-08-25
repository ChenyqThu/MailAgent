// lucide-animated · wind-arrow-down。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const WIND_VARIANTS: Variants = {
  normal: (custom: number) => ({
    pathLength: 1,
    opacity: 1,
    pathOffset: 0,
    transition: { duration: 0.3, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  }),
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: { duration: 0.5, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  })
}

const ARROW_VARIANTS: Variants = {
  normal: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    y: [-10, 0],
    opacity: [0, 1],
    transition: { duration: 0.5, ease: ICON_EASE, delay: 0.35, type: 'tween' as const }
  }
}

export function WindArrowDownIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={0.2} d="M12.8 21.6A2 2 0 1 0 14 18H2" variants={WIND_VARIANTS} />
      <motion.path custom={0.4} d="M17.5 10a2.5 2.5 0 1 1 2 4H2" variants={WIND_VARIANTS} />
      <motion.path d="M10 2v8" variants={ARROW_VARIANTS} />
      <motion.path d="m6 6 4 4 4-4" variants={ARROW_VARIANTS} />
    </IconShell>
  )
}
