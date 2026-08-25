// lucide-animated · refresh-ccw-dot。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function RefreshCcwDotIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        transition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={{ normal: { rotate: '0deg' }, animate: { rotate: '-50deg' } }}
      >
        <path d="M3 2v6h6" />
        <path d="M21 12A9 9 0 0 0 6 5.3L3 8" />
        <path d="M21 22v-6h-6" />
        <path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
      </motion.g>
      <circle cx="12" cy="12" r="1" />
    </IconShell>
  )
}
