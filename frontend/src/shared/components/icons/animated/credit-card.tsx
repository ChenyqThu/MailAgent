// lucide-animated · credit-card。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CARD_VARIANTS: Variants = {
  normal: { x: 0, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } },
  animate: {
    x: [0, -4, 1.5, 0],
    transition: { duration: 0.7, times: [0, 0.4, 0.75, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CreditCardIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g variants={CARD_VARIANTS}>
        <rect height="14" rx="2" width="20" x="2" y="5" />
        <line x1="2" x2="22" y1="10" y2="10" />
      </motion.g>
    </IconShell>
  )
}
