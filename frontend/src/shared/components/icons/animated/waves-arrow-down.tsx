// lucide-animated · waves-arrow-down。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, 3, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SHAFT_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0, scale: 1 },
  animate: {
    translateY: [0, 3, 0],
    scale: [1, 0.85, 1],
    originX: 1,
    originY: 1,
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function WavesArrowDownIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.path d="M12 10L12 2" variants={SHAFT_VARIANTS} />
      <motion.path d="M16 6L12 10L8 6" variants={HEAD_VARIANTS} />
      <path d="M2 15C2.6 15.5 3.2 16 4.5 16C7 16 7 14 9.5 14C12.1 14 11.9 16 14.5 16C17 16 17 14 19.5 14C20.8 14 21.4 14.5 22 15" />
      <path d="M2 21C2.6 21.5 3.2 22 4.5 22C7 22 7 20 9.5 20C12.1 20 11.9 22 14.5 22C17 22 17 20 19.5 20C20.8 20 21.4 20.5 22 21" />
    </IconShell>
  )
}
