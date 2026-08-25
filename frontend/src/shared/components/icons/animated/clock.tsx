// lucide-animated · clock。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HAND_TRANSITION: Transition = { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }

const HAND_VARIANTS: Variants = {
  normal: { rotate: 0, originX: '0%', originY: '100%' },
  animate: { rotate: 360, originX: '0%', originY: '100%' }
}

const MINUTE_HAND_TRANSITION: Transition = {
  duration: 0.5,
  ease: ICON_EASE,
  type: 'tween' as const
}

const MINUTE_HAND_VARIANTS: Variants = {
  normal: { rotate: 0, originX: '0%', originY: '100%' },
  animate: { rotate: 45, originX: '0%', originY: '100%' }
}

export function ClockIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <motion.line
        transition={HAND_TRANSITION}
        variants={HAND_VARIANTS}
        x1="12"
        x2="12"
        y1="12"
        y2="6"
      />
      <motion.line
        transition={MINUTE_HAND_TRANSITION}
        variants={MINUTE_HAND_VARIANTS}
        x1="12"
        x2="16"
        y1="12"
        y2="12"
      />
    </IconShell>
  )
}
