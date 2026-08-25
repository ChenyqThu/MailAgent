// lucide-animated · cloud-lightning。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function CloudLightningIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973" />
      <motion.path
        d="m13 12-3 5h4l-3 5"
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
