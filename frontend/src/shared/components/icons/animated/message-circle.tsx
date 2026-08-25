// lucide-animated · message-circle。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×2。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ICON_VARIANTS: Variants = {
  normal: { scale: 1, rotate: 0 },
  animate: {
    scale: 1.05,
    rotate: [0, -7, 7, 0],
    transition: {
      rotate: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const },
      scale: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

export function MessageCircleIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={ICON_VARIANTS}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </IconShell>
  )
}
