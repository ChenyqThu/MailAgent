// lucide-animated · wrench。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ICON_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    rotate: [0, 12, -14, 4, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.42, 0.68, 0.88, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

export function WrenchIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={ICON_VARIANTS}
      svgStyle={{ transformOrigin: '90% 10%', transformBox: 'fill-box' }}
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
    </IconShell>
  )
}
