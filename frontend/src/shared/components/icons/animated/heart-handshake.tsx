// lucide-animated · heart-handshake。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function HeartHandshakeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { scale: 1, rotate: 0 },
        animate: {
          scale: [1, 0.9, 1, 1, 1, 1, 1],
          rotate: [0, 0, 0, -7, 7, -3, 0],
          transition: {
            duration: 0.7,
            times: [0, 0.15, 0.3, 0.4, 0.55, 0.75, 1],
            ease: ICON_EASE,
            type: 'tween' as const
          }
        }
      }}
      svgStyle={{ originX: '50%', originY: '50%' }}
    >
      <path d="M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762" />
    </IconShell>
  )
}
