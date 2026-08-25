// lucide-animated · battery-warning。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BatteryWarningIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M14 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
      <path d="M22 14v-4" />
      <path d="M6 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />

      <motion.g
        style={{ originX: '50%', originY: '50%' }}
        variants={{
          normal: { opacity: 1, scale: 1 },
          animate: {
            opacity: [1, 0.4, 1],
            scale: [1, 1.1, 1],
            transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      >
        <path d="M10 17h.01" />
        <path d="M10 7v6" />
      </motion.g>
    </IconShell>
  )
}
