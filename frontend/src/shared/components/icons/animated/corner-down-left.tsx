// lucide-animated · corner-down-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const STRETCH_VARIANTS: Variants = {
  normal: { scaleX: 1, x: 0, opacity: 1 },
  animate: {
    scaleX: [1, 1.15, 1],
    x: [0, -2, 0],
    transition: { duration: 0.45, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CornerDownLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={STRETCH_VARIANTS}>
      <path d="M4 15h12a4 4 0 0 0 4-4V4" />
      <path d="m9 20-5-5 5-5" />
    </IconShell>
  )
}
