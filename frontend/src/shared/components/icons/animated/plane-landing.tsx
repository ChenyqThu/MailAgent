// lucide-animated · plane-landing。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PLANE_LANDING_VARIANTS: Variants = {
  normal: { x: 0, y: 0, opacity: 1, scale: 1, rotate: 0 },
  animate: {
    x: [-38, 1, 0],
    y: [-20, 1, 0],
    opacity: [0, 1, 1],
    scale: [0.5, 1],
    rotate: [16, -5, 0],
    transition: { duration: 0.6, ease: ICON_EASE, times: [0, 0.65, 1], type: 'tween' as const }
  }
}

export function PlaneLandingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M2 22h20" />
      <motion.path
        d="M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.49.88-.06 1.98-1.06 2.1l-1.18.15c-.47.06-.95-.02-1.37-.24L4.29 11.15a2 2 0 0 1-.52-.38Z"
        style={{ originX: 0.5, originY: 0.5 }}
        variants={PLANE_LANDING_VARIANTS}
      />
    </IconShell>
  )
}
