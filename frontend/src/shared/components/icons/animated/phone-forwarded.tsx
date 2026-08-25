// lucide-animated · phone-forwarded。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PHONE_FORWARDED_VARIANTS: Variants = {
  normal: { rotate: 0, scale: 1 },
  animate: {
    scale: [1, 1.1, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const HEAD_VARIANTS: Variants = {
  normal: { translateX: 0 },
  animate: {
    translateX: [0, 3, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SHAFT_VARIANTS: Variants = {
  normal: { translateX: 0, scale: 1 },
  animate: {
    translateX: [0, 3, 0],
    scale: [1, 0.85, 1],
    originX: 1,
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function PhoneForwardedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={PHONE_FORWARDED_VARIANTS} svgStyle={{ overflow: 'visible' }}>
      <motion.path d="M14 6h8" variants={SHAFT_VARIANTS} />
      <motion.path d="m18 2 4 4-4 4" variants={HEAD_VARIANTS} />

      <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
    </IconShell>
  )
}
