// lucide-animated · smartphone-charging。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function SmartphoneChargingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="20" rx="2" ry="2" width="14" x="5" y="2" />
      <motion.path
        d="M12.667 8 10 12h4l-2.667 4"
        variants={{
          normal: { opacity: 1 },
          animate: {
            opacity: [1, 0.4, 1],
            transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      />
    </IconShell>
  )
}
