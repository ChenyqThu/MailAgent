// lucide-animated · rabbit。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants, Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }

const SPEED_VARIANTS: Variants = {
  normal: { rotate: 0, x: 0, y: 0 },
  animate: {
    rotate: [0, 5, -5, 3, -3, 0],
    x: [0, 3, -3, 2, -2, 0],
    y: [0, 1.5, -1.5, 1, -1, 0],
    transition: TRANSITION
  }
}

export function RabbitIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={SPEED_VARIANTS}>
      <path d="M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3" />
      <path d="M13 16a3 3 0 0 1 2.24 5" />
      <path d="M18 12h.01" />
      <path d="M20 8.54V4a2 2 0 1 0-4 0v3" />
      <path d="M7.612 12.524a3 3 0 1 0-1.6 4.3" />
    </IconShell>
  )
}
