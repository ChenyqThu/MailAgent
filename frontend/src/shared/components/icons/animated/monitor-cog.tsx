// lucide-animated · monitor-cog。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const G_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: 180 } }

export function MonitorCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M12 17v4" />
      <path d="M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
      <path d="M8 21h8" />

      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={G_VARIANTS}
      >
        <path d="m14.305 7.53.923-.382" />
        <path d="m15.228 4.852-.923-.383" />
        <path d="m16.852 3.228-.383-.924" />
        <path d="m16.852 8.772-.383.923" />
        <path d="m19.148 3.228.383-.924" />
        <path d="m19.53 9.696-.382-.924" />
        <path d="m20.772 4.852.924-.383" />
        <path d="m20.772 7.148.924.383" />
        <circle cx="18" cy="6" r="3" />
      </motion.g>
    </IconShell>
  )
}
