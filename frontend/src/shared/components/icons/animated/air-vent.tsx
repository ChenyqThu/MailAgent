// lucide-animated · air-vent。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const WIND_VARIANTS: Variants = {
  normal: (custom: number) => ({
    pathLength: 1,
    opacity: 1,
    pathOffset: 0,
    transition: { duration: 0.3, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  }),
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: { duration: 0.5, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  })
}

export function AirVentIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M6 12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 8h12" />
      <motion.path
        custom={0}
        d="M18.3 17.7a2.5 2.5 0 0 1-3.16 3.83 2.53 2.53 0 0 1-1.14-2V12"
        variants={WIND_VARIANTS}
      />
      <motion.path custom={0.2} d="M6.6 15.6A2 2 0 1 0 10 17v-5" variants={WIND_VARIANTS} />
    </IconShell>
  )
}
