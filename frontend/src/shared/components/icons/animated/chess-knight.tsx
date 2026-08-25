// lucide-animated · chess-knight。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const KNIGHT_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    y: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    rotate: [0, 12, 38, 42, 38, 10, -5, 0],
    y: [0, -2, -9, -12, -9, -2, 1, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.1, 0.3, 0.45, 0.6, 0.78, 0.9, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

export function ChessKnightIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 22px' }}
        variants={KNIGHT_VARIANTS}
      >
        <path d="M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
        <path d="M16.5 18c1-2 2.5-5 2.5-9a7 7 0 0 0-7-7H6.635a1 1 0 0 0-.768 1.64L7 5l-2.32 5.802a2 2 0 0 0 .95 2.526l2.87 1.456" />
        <path d="m15 5 1.425-1.425" />
        <path d="m17 8 1.53-1.53" />
        <path d="M9.713 12.185 7 18" />
      </motion.g>
    </IconShell>
  )
}
