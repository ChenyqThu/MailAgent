// lucide-animated · alarm-clock-minus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function AlarmClockMinusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.circle cx="12" cy="13" r="8" variants={PATH_VARIANTS} />
      <motion.path d="M5 3 2 6" variants={SECONDARY_PATH_VARIANTS} />
      <motion.path d="m22 6-3-3" variants={SECONDARY_PATH_VARIANTS} />
      <motion.path d="M6.38 18.7 4 21" variants={PATH_VARIANTS} />
      <motion.path d="M17.64 18.67 20 21" variants={PATH_VARIANTS} />
      <motion.path d="M9 13h6" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
