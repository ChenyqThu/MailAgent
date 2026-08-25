// lucide-animated · hat-glasses。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HAT_VARIANTS: Variants = {
  normal: { rotate: 0, y: 0 },
  animate: {
    rotate: [0, -4, 2, 0],
    y: [0, -3, 1, 0],
    transition: {
      duration: 0.5,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 1],
      type: 'tween' as const
    }
  }
}

const GLASSES_VARIANTS: Variants = {
  normal: { scale: 1, y: 0 },
  animate: {
    scale: [1, 0.96, 1],
    y: [0, 1, 0],
    transition: { delay: 0.28, duration: 0.32, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function HatGlassesIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g style={{ originX: '12px', originY: '11px' }} variants={HAT_VARIANTS}>
        <path d="m19 11-2.11-6.657a2 2 0 0 0-2.752-1.148l-1.276.61A2 2 0 0 1 12 4H8.5a2 2 0 0 0-1.925 1.456L5 11" />
        <path d="M2 11h20" />
      </motion.g>

      <motion.g variants={GLASSES_VARIANTS}>
        <path d="M14 18a2 2 0 0 0-4 0" />
        <circle cx="17" cy="18" r="3" />
        <circle cx="7" cy="18" r="3" />
      </motion.g>
    </IconShell>
  )
}
