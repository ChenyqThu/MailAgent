// lucide-animated · hammer。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HAMMER_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    rotate: [0, -20, 25, 0],
    transition: { duration: 0.8, times: [0, 0.6, 0.8, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function HammerIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={HAMMER_VARIANTS}
      svgStyle={{ transformOrigin: '0% 100%', transformBox: 'fill-box' }}
    >
      <path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" />
      <path d="m18 15 4-4" />
      <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
    </IconShell>
  )
}
