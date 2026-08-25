// lucide-animated · battery-plus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BatteryPlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M12.543 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.605" />
      <path d="M22 14v-4" />
      <path d="M7.606 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.606" />

      <motion.g
        style={{ originX: '50%', originY: '50%' }}
        variants={{
          normal: { opacity: 1, scale: 1 },
          animate: {
            opacity: [1, 0.5, 1],
            scale: [1, 0.8, 1.2, 1],
            transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      >
        <path d="M10 9v6" />
        <path d="M7 12h6" />
      </motion.g>
    </IconShell>
  )
}
