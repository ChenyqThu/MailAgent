// lucide-animated · waves-ladder。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function WavesLadderIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
      <motion.g
        variants={{
          normal: { y: 0, opacity: 1 },
          animate: {
            y: [13, 0],
            opacity: [0, 0, 1],
            transition: {
              duration: 0.6,
              times: [0, 0.5, 1],
              type: 'tween' as const,
              ease: ICON_EASE
            }
          }
        }}
      >
        <path d="M19 5a2 2 0 0 0-2 2v11" />
        <path d="M7 13h10" />
        <path d="M7 9h10" />
        <path d="M9 5a2 2 0 0 0-2 2v11" />
      </motion.g>
    </IconShell>
  )
}
