// lucide-animated · file-cog。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const G_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: 180 } }

export function FileCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5" />
      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={G_VARIANTS}
      >
        <path d="m3.2 12.9-.9-.4" />
        <path d="m3.2 15.1-.9.4" />
        <path d="m4.9 11.2-.4-.9" />
        <path d="m4.9 16.8-.4.9" />
        <path d="m7.5 10.3-.4.9" />
        <path d="m7.5 17.7-.4-.9" />
        <path d="m9.7 12.5-.9.4" />
        <path d="m9.7 15.5-.9-.4" />
        <circle cx="6" cy="14" r="3" />
      </motion.g>
    </IconShell>
  )
}
