// lucide-animated · figma。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      delay: 0.3,
      duration: 0.5,
      opacity: { delay: 0.25, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function FigmaIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z"
        variants={VARIANTS}
      />
      <motion.path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z" variants={VARIANTS} />
      <motion.path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z" variants={VARIANTS} />
      <motion.path d="M5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0z" variants={VARIANTS} />
      <motion.path
        d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z"
        variants={VARIANTS}
      />
    </IconShell>
  )
}
