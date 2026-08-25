// lucide-animated · earth。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×4。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLE_TRANSITION: Transition = {
  duration: 0.3,
  delay: 0.1,
  opacity: { delay: 0.15, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
  type: 'tween' as const,
  ease: ICON_EASE
}

const CIRCLE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: { pathLength: [0, 1], opacity: [0, 1] }
}

export function EarthIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M21.54 15H17a2 2 0 0 0-2 2v4.54"
        transition={{
          duration: 0.7,
          delay: 0.5,
          opacity: { delay: 0.5, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
          type: 'tween' as const,
          ease: ICON_EASE
        }}
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />
      <motion.path
        d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"
        transition={{
          duration: 0.7,
          delay: 0.5,
          opacity: { delay: 0.5, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
          type: 'tween' as const,
          ease: ICON_EASE
        }}
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />
      <motion.path
        d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"
        transition={{
          duration: 0.7,
          delay: 0.5,
          opacity: { delay: 0.5, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
          type: 'tween' as const,
          ease: ICON_EASE
        }}
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />
      <motion.circle
        cx="12"
        cy="12"
        r="10"
        transition={CIRCLE_TRANSITION}
        variants={CIRCLE_VARIANTS}
      />
    </IconShell>
  )
}
