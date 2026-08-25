// lucide-animated · gavel。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const GAVEL_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    rotate: [0, -20, 25, 0],
    transition: { duration: 0.8, times: [0, 0.6, 0.8, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function GavelIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={GAVEL_VARIANTS}
      svgStyle={{ transformOrigin: '0% 100%', transformBox: 'fill-box' }}
    >
      <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381" />
      <path d="m16 16 6-6" />
      <path d="m21.5 10.5-8-8" />
      <path d="m8 8 6-6" />
      <path d="m8.5 7.5 8 8" />
    </IconShell>
  )
}
