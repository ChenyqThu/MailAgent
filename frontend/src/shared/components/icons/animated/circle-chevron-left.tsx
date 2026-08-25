// lucide-animated · circle-chevron-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
  type: 'tween' as const,
  ease: ICON_EASE
}

export function CircleChevronLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <motion.path
        d="m14 16-4-4 4-4"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { x: 0 }, animate: { x: [0, -2, 0] } }}
      />
    </IconShell>
  )
}
