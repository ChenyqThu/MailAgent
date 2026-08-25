// lucide-animated · plus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function PlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{ normal: { rotate: 0 }, animate: { rotate: 180 } }}
      svgTransition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </IconShell>
  )
}
