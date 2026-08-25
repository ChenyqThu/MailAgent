// lucide-animated · washing-machine。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；去 repeat 循环 ×3；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function WashingMachineIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        variants={{
          normal: { x: 0 },
          animate: {
            x: [0, 0.5, -0.5, 0.3, -0.3, 0],
            transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      >
        <path d="M3 6h3" />
        <path d="M17 6h.01" />
        <rect height="20" rx="2" width="18" x="3" y="2" />
      </motion.g>
      <motion.g
        variants={{
          normal: {
            rotate: 0,
            y: 0,
            transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
          },
          animate: {
            rotate: 360,
            y: [0, -0.3, 0, 0.3, 0],
            transition: {
              rotate: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const },
              y: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const },
              type: 'tween' as const,
              duration: 0.4,
              ease: ICON_EASE
            }
          }
        }}
      >
        <circle cx="12" cy="13" r="5" />
        <path d="M12 18a2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5" />
      </motion.g>
    </IconShell>
  )
}
