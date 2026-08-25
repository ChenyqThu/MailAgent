// lucide-animated · party-popper。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINES_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1, scale: 1, translateX: 0, translateY: 0 },
  animate: {
    opacity: [0, 1],
    scale: [0.3, 0.8, 1, 1.1, 1],
    pathLength: [0, 0.5, 1],
    translateX: [-5, 0],
    translateY: [5, 0],
    transition: { duration: 0.7, type: 'tween' as const, ease: ICON_EASE }
  }
}

const DOTS_VARIANTS: Variants = {
  normal: { opacity: 1, scale: 1, translateX: 0, translateY: 0 },
  animate: {
    opacity: [0, 1],
    translateX: [-5, 0],
    translateY: [5, 0],
    scale: [0.5, 0.8, 1, 1.1, 1],
    transition: { duration: 0.7, type: 'tween' as const, ease: ICON_EASE }
  }
}

const POPPER_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [-1.5, 0],
    translateY: [1.5, 0],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function PartyPopperIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M5.8 11.3 2 22l10.7-3.79" variants={POPPER_VARIANTS} />
      <motion.path
        d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"
        variants={POPPER_VARIANTS}
      />
      <motion.path d="M4 3h.01" variants={DOTS_VARIANTS} />
      <motion.path d="M22 8h.01" variants={DOTS_VARIANTS} />
      <motion.path d="M15 2h.01" variants={DOTS_VARIANTS} />
      <motion.path d="M22 20h.01" variants={DOTS_VARIANTS} />
      <motion.path
        d="m14 10 1.21-1.06c0.16-0.84 0.9-1.44 1.76-1.44h0.38c0.88 0 1.55-0.77 1.45-1.63a2.9 2.9 0 0 1 1.96-3.12L22 2"
        variants={LINES_VARIANTS}
      />
      <motion.path
        d="M17 15h0.77c0.71 0 1.32-0.52 1.43-1.22c0.16-0.91 1.12-1.45 1.98-1.11L22 13"
        variants={LINES_VARIANTS}
      />
      <motion.path
        d="M9 7V6.23c0-0.71 0.52-1.33 1.22-1.43c0.91-0.16 1.45-1.12 1.11-1.98L11 2"
        variants={LINES_VARIANTS}
      />
    </IconShell>
  )
}
