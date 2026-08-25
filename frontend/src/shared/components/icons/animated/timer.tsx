// lucide-animated · timer。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HAND_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    originX: '0%',
    originY: '100%',
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    rotate: 300,
    originX: '0%',
    originY: '100%',
    transition: { delay: 0.1, duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const BUTTON_VARIANTS: Variants = {
  normal: { scale: 1, y: 0 },
  animate: {
    scale: [0.9, 1],
    y: [0, 1, 0],
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function TimerIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.line variants={BUTTON_VARIANTS} x1="10" x2="14" y1="2" y2="2" />
      <motion.line variants={HAND_VARIANTS} x1="12" x2="15" y1="14" y2="11" />
      <circle cx="12" cy="14" r="8" />
    </IconShell>
  )
}
