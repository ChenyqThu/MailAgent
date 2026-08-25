// lucide-animated · server-cog。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const COG_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: 180 } }

export function ServerCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={COG_VARIANTS}
      >
        <path d="m10.852 14.772-.383.923" />
        <path d="M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923" />
        <path d="m13.148 9.228.383-.923" />
        <path d="m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544" />
        <path d="m14.772 10.852.923-.383" />
        <path d="m14.772 13.148.923.383" />
        <path d="m9.228 10.852-.923-.383" />
        <path d="m9.228 13.148-.923.383" />
      </motion.g>

      <path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5" />
      <path d="M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5" />
      <path d="M6 18h.01" />
      <path d="M6 6h.01" />
    </IconShell>
  )
}
