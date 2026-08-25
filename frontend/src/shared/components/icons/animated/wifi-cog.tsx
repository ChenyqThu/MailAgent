// lucide-animated · wifi-cog。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const COG_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: 180 } }

export function WifiCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 7.82a15 15 0 0 1 20 0" />
      <path d="M5 11.858a10 10 0 0 1 11.5-1.785" />
      <path d="M8.5 15.429a5 5 0 0 1 2.413-1.31" />
      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={COG_VARIANTS}
      >
        <path d="m14.305 19.53.923-.382" />
        <path d="m15.228 16.852-.923-.383" />
        <path d="m16.852 15.228-.383-.923" />
        <path d="m16.852 20.772-.383.924" />
        <path d="m19.148 15.228.383-.923" />
        <path d="m19.53 21.696-.382-.924" />
        <path d="m20.772 16.852.924-.383" />
        <path d="m20.772 19.148.924.383" />
        <circle cx="18" cy="18" r="3" />
      </motion.g>
    </IconShell>
  )
}
