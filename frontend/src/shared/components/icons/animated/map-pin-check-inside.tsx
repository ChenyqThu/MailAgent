// lucide-animated · map-pin-check-inside。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SVG_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, -5, -3],
    transition: { duration: 0.5, times: [0, 0.6, 1], type: 'tween' as const, ease: ICON_EASE }
  }
}

const CHECK_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function MapPinCheckInsideIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={SVG_VARIANTS}>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <motion.path d="m9 10 2 2 4-4" variants={CHECK_VARIANTS} />
    </IconShell>
  )
}
