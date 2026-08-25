// lucide-animated · book-text。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BookTextIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        animate: {
          scale: [1, 1.04, 1],
          rotate: [0, -8, 8, -8, 0],
          y: [0, -2, 0],
          transition: {
            duration: 0.6,
            ease: ICON_EASE,
            times: [0, 0.2, 0.5, 0.8, 1],
            type: 'tween' as const
          }
        },
        normal: { scale: 1, rotate: 0, y: 0 }
      }}
    >
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
      <path d="M8 11h8" />
      <path d="M8 7h6" />
    </IconShell>
  )
}
