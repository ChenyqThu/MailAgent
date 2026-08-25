// lucide-animated · gitlab。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DURATION = 0.7

const CALCULATE_DELAY = (i: number): number => {
  if (i === 0) return 0.1

  return i * DURATION + 0.1
}

export function GitlabIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"
        transition={{
          duration: 0.7,
          delay: CALCULATE_DELAY(0),
          opacity: {
            delay: CALCULATE_DELAY(0),
            type: 'tween' as const,
            duration: 0.4,
            ease: ICON_EASE
          },
          type: 'tween' as const,
          ease: ICON_EASE
        }}
        variants={{
          normal: {
            pathLength: 1,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathLength: [0, 1], opacity: [0, 1] }
        }}
      />
    </IconShell>
  )
}
