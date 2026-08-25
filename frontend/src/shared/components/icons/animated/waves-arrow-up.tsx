// lucide-animated · waves-arrow-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, -3, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SHAFT_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0, scale: 1 },
  animate: {
    translateY: [0, -3, 0],
    scale: [1, 0.85, 1],
    originX: 1,
    originY: 1,
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function WavesArrowUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.path d="M12 2v8" variants={SHAFT_VARIANTS} />
      <motion.path d="m8 6 4-4 4 4" variants={HEAD_VARIANTS} />
      <path d="M2 15c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
      <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
    </IconShell>
  )
}
