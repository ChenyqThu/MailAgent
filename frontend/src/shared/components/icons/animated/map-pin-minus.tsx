// lucide-animated · map-pin-minus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

const MINUS_VARIANTS: Variants = {
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

export function MapPinMinusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={SVG_VARIANTS}>
      <path d="M18.977 14C19.6 12.701 20 11.343 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738" />
      <circle cx="12" cy="10" r="3" />
      <motion.path d="M16 18h6" variants={MINUS_VARIANTS} />
    </IconShell>
  )
}
