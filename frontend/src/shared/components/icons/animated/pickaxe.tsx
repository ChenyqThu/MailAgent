// lucide-animated · pickaxe。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import type { Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PICKAXE_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    rotate: [0, -20, 25, 0],
    transition: { duration: 0.8, times: [0, 0.6, 0.8, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function PickaxeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={PICKAXE_VARIANTS}
      svgStyle={{ transformOrigin: '0% 100%', transformBox: 'fill-box' }}
    >
      <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999" />
      <path d="M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024" />
      <path d="M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069" />
      <path d="M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z" />
    </IconShell>
  )
}
