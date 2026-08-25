// lucide-animated · axe。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const AXE_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    rotate: [0, -20, 25, 0],
    transition: { duration: 0.8, times: [0, 0.6, 0.8, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function AxeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={AXE_VARIANTS}
      svgStyle={{ transformOrigin: '0% 100%', transformBox: 'fill-box' }}
    >
      <path d="m14 12-8.381 8.38a1 1 0 0 1-3.001-3L11 9" />
      <path d="M15 15.5a.5.5 0 0 0 .5.5A6.5 6.5 0 0 0 22 9.5a.5.5 0 0 0-.5-.5h-1.672a2 2 0 0 1-1.414-.586l-5.062-5.062a1.205 1.205 0 0 0-1.704 0L9.352 5.648a1.205 1.205 0 0 0 0 1.704l5.062 5.062A2 2 0 0 1 15 13.828z" />
    </IconShell>
  )
}
