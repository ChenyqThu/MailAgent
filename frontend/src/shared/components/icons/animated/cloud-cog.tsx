// lucide-animated · cloud-cog。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const G_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: 180 } }

export function CloudCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={G_VARIANTS}
      >
        <path d="m9.2 15.9-.9-.4" />
        <path d="m9.2 18.1-.9.4" />
        <path d="m10.9 14.2-.4-.9" />
        <path d="m10.9 19.8-.4.9" />
        <path d="m13.5 13.3-.4.9" />
        <path d="m13.5 20.7-.4-.9" />
        <path d="m15.7 15.5-.9.4" />
        <path d="m15.7 18.5-.9-.4" />
        <circle cx="12" cy="17" r="3" />
      </motion.g>
    </IconShell>
  )
}
