// lucide-animated · key。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function KeyIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: {
          rotate: 0,
          transition: { type: 'tween' as const, duration: 0.8, ease: ICON_EASE }
        },
        animate: {
          rotate: [-3, -33, -25, -28],
          transition: {
            duration: 0.6,
            times: [0, 0.6, 0.8, 1],
            ease: ICON_EASE,
            type: 'tween' as const
          }
        }
      }}
      svgStyle={{ originX: 0.3, originY: 0.7 }}
    >
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </IconShell>
  )
}
