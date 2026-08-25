// lucide-animated · battery。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BatteryIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="12" rx="2" width="16" x="2" y="6" />
      <path d="M22 14v-4" />

      <motion.rect
        fill="currentColor"
        height="8"
        rx="1"
        stroke="none"
        variants={{
          normal: { width: 0, opacity: 0 },
          animate: {
            width: 12,
            opacity: 1,
            transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
        x="4"
        y="8"
      />
    </IconShell>
  )
}
