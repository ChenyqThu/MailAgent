// lucide-animated · disc-3。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function Disc3Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2" />

      <motion.g
        style={{ transformOrigin: '12px 12px' }}
        transition={{ duration: 0.4, ease: ICON_EASE, type: 'tween' as const }}
        variants={{ normal: { rotate: 0 }, animate: { rotate: 90 } }}
      >
        <path d="M6 12c0-1.7.7-3.2 1.8-4.2" />
        <path d="M18 12c0 1.7-.7 3.2-1.8 4.2" />
      </motion.g>
    </IconShell>
  )
}
