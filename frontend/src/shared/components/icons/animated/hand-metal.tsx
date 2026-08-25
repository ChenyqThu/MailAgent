// lucide-animated · hand-metal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function HandMetalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { rotate: 0 },
        animate: {
          rotate: [0, -15, 15, -10, 10, 0],
          transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
        }
      }}
      svgStyle={{ originX: '50%', originY: '90%' }}
    >
      <path d="M18 12.5V10a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4" />
      <path d="M14 11V9a2 2 0 1 0-4 0v2" />
      <path d="M10 10.5V5a2 2 0 1 0-4 0v9" />
      <path d="m7 15-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6C7.5 21.14 9.2 22 12 22h2a8 8 0 0 0 8-8V7a2 2 0 1 0-4 0v5" />
    </IconShell>
  )
}
