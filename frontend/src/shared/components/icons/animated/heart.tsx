// lucide-animated · heart。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function HeartIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{ normal: { scale: 1 }, animate: { scale: [1, 1.08, 1] } }}
      svgTransition={{ duration: 0.45, type: 'tween' as const, ease: ICON_EASE }}
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </IconShell>
  )
}
