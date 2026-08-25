// lucide-animated · battery-charging。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BatteryChargingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935" />
      <path d="M22 14v-4" />
      <path d="M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936" />
      <motion.path
        d="m11 7-3 5h4l-3 5"
        style={{ originX: '50%', originY: '50%' }}
        variants={{
          normal: { scale: 1, opacity: 1 },
          animate: {
            scale: [1, 1.2, 1],
            opacity: [1, 0.8, 1],
            transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      />
    </IconShell>
  )
}
