// lucide-animated · undo-dot。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function UndoDotIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M3 7v6h6"
        transition={{ duration: 0.6, ease: ICON_EASE, type: 'tween' as const }}
        variants={{
          normal: { translateX: 0, translateY: 0, rotate: 0 },
          animate: { translateX: [0, 2.1, 0], translateY: [0, -1.4, 0], rotate: [0, 12, 0] }
        }}
      />
      <motion.path
        d="M21 17a9 9 0 0 0-15-6.7L3 13"
        transition={{ duration: 0.6, ease: ICON_EASE, type: 'tween' as const }}
        variants={{ normal: { pathLength: 1 }, animate: { pathLength: [1, 0.8, 1] } }}
      />
      <motion.circle
        cx="12"
        cy="17"
        r="1"
        transition={{ duration: 0.6, ease: ICON_EASE, type: 'tween' as const }}
        variants={{ normal: { scale: 1 }, animate: { scale: [1, 1.2, 1] } }}
      />
    </IconShell>
  )
}
