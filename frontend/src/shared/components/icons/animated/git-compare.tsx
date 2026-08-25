// lucide-animated · git-compare。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×8。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DURATION = 0.3

const CALCULATE_DELAY = (i: number): number => {
  if (i === 0) return 0.1

  return i * DURATION + 0.1
}

export function GitCompareIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle
        cx="18"
        cy="18"
        r="3"
        transition={{
          duration: 0.3,
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

      <motion.path
        d="M13 6h3a2 2 0 0 1 2 2v7"
        transition={{
          duration: 0.3,
          delay: CALCULATE_DELAY(1),
          opacity: {
            delay: CALCULATE_DELAY(1),
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
            pathOffset: 0,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />

      <motion.path
        d="M11 18H8a2 2 0 0 1-2-2V9"
        transition={{
          duration: 0.3,
          delay: CALCULATE_DELAY(1),
          opacity: {
            delay: CALCULATE_DELAY(1),
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
            pathOffset: 0,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />

      <motion.circle
        cx="6"
        cy="6"
        r="3"
        transition={{
          duration: 0.3,
          delay: CALCULATE_DELAY(2),
          opacity: {
            delay: CALCULATE_DELAY(2),
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
