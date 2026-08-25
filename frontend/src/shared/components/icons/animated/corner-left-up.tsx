// lucide-animated · corner-left-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const STRETCH_VARIANTS: Variants = {
  normal: { scaleY: 1, y: 0, opacity: 1 },
  animate: {
    scaleY: [1, 1.15, 1],
    y: [0, -2, 0],
    transition: { duration: 0.45, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CornerLeftUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={STRETCH_VARIANTS}>
      <path d="M14 9 9 4 4 9" />
      <path d="M20 20h-7a4 4 0 0 1-4-4V4" />
    </IconShell>
  )
}
