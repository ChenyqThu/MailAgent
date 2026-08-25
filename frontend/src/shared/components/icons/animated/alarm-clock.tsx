// lucide-animated · alarm-clock。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×4；补显式 transition/duration ×2；去 repeat 循环 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { y: 0, x: 0, transition: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE } },
  animate: {
    y: -1.5,
    x: [-1, 1, -1, 1, -1, 0],
    transition: {
      y: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      x: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

const SECONDARY_PATH_VARIANTS: Variants = {
  normal: { y: 0, x: 0, transition: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE } },
  animate: {
    y: -2.5,
    x: [-2, 2, -2, 2, -2, 0],
    transition: {
      y: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      x: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

export function AlarmClockIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.path d="M18 20.5L19.5 22" variants={PATH_VARIANTS} />
      <motion.path d="M6 20.5L4.5 22" variants={PATH_VARIANTS} />
      <motion.path
        d="M21 13C21 17.968 16.968 22 12 22C7.032 22 3 17.968 3 13C3 8.032 7.032 4 12 4C16.968 4 21 8.032 21 13Z"
        variants={PATH_VARIANTS}
      />
      <motion.path
        d="M15.339 15.862L12.549 14.197C12.063 13.909 11.667 13.216 11.667 12.649V8.95898"
        variants={PATH_VARIANTS}
      />
      <motion.path d="M18 2L21.747 5.31064" variants={SECONDARY_PATH_VARIANTS} />
      <motion.path d="M6 2L2.25304 5.31064" variants={SECONDARY_PATH_VARIANTS} />
    </IconShell>
  )
}
