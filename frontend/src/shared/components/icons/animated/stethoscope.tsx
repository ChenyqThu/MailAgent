// lucide-animated · stethoscope。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×10。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DURATION = 0.25

const CALCULATE_DELAY = (i: number): number => (i === 0 ? 0.1 : i * DURATION + 0.1)

export function StethoscopeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M11 2v2"
        transition={{
          duration: 0.25,
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
            pathOffset: 0,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathOffset: [1, 0], pathLength: [0, 1], opacity: [0, 1] }
        }}
      />
      <motion.path
        d="M5 2v2"
        transition={{
          duration: 0.25,
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
            pathOffset: 0,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathOffset: [1, 0], pathLength: [0, 1], opacity: [0, 1] }
        }}
      />
      <motion.path
        d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"
        transition={{
          duration: 0.25,
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
            pathOffset: 0,
            opacity: 1,
            transition: { delay: 0, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          },
          animate: { pathLength: [0, 1], pathOffset: [1, 0], opacity: [0, 1] }
        }}
      />
      <motion.path
        d="M8 15a6 6 0 0 0 12 0v-3"
        transition={{
          duration: 0.25,
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
          animate: { pathOffset: [1, 0], pathLength: [0, 1], opacity: [0, 1] }
        }}
      />
      <motion.circle
        cx="20"
        cy="10"
        r="2"
        transition={{
          duration: 0.25,
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
