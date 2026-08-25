// lucide-animated · home。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = {
  duration: 0.6,
  opacity: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
  type: 'tween' as const,
  ease: ICON_EASE
}

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: { opacity: [0, 1], pathLength: [0, 1] }
}

export function HomeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <motion.path
        d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"
        transition={DEFAULT_TRANSITION}
        variants={PATH_VARIANTS}
      />
    </IconShell>
  )
}
