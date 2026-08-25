// lucide-animated · lock-keyhole。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function LockKeyholeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { rotate: 0, scale: 1 },
        animate: { rotate: [-3, 1, -2, 0], scale: [0.95, 1.05, 0.98, 1] }
      }}
      svgTransition={{ duration: 0.6, ease: ICON_EASE, type: 'tween' as const }}
    >
      <circle cx="12" cy="16" r="1" />
      <rect height="12" rx="2" width="18" x="3" y="10" />
      <motion.path
        d="M7 10V7a5 5 0 0 1 10 0v3"
        transition={{ duration: 0.3, ease: ICON_EASE, type: 'tween' as const }}
        variants={{ normal: { pathLength: 1 }, animate: { pathLength: 0.7 } }}
      />
    </IconShell>
  )
}
