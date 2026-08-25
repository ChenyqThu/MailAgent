// lucide-animated · banana。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = {
  duration: 0.3,
  delay: 0.1,
  opacity: { delay: 0.15, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
  type: 'tween' as const,
  ease: ICON_EASE
}

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { delay: custom * 0.1, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  })
}

export function BananaIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        custom={2}
        d="M4 13c3.5-2 8-2 10 2a5.5 5.5 0 0 1 8 5"
        transition={TRANSITION}
        variants={VARIANTS}
      />
      <motion.path
        custom={0}
        d="M5.15 17.89c5.52-1.52 8.65-6.89 7-12C11.55 4 11.5 2 13 2c3.22 0 5 5.5 5 8 0 6.5-4.2 12-10.49 12C5.11 22 2 22 2 20c0-1.5 1.14-1.55 3.15-2.11Z"
        transition={TRANSITION}
        variants={VARIANTS}
      />
    </IconShell>
  )
}
