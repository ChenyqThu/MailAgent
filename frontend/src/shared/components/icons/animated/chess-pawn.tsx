// lucide-animated · chess-pawn。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×2；时长收敛 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD_VARIANTS: Variants = {
  normal: {
    x: 0,
    y: 0,
    scale: 1,
    rotate: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    x: [0, -5, 5, 0],
    rotate: [0, -15, 15, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.33, 0.66, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

const BODY_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } },
  animate: {
    rotate: [0, 5, 5, 5, 3, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.08, 0.3, 0.52, 0.72, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

export function ChessPawnIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 21px' }}
        variants={BODY_VARIANTS}
      >
        <path d="M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
        <path d="m14.5 10 1.5 8" />
        <path d="M7 10h10" />
        <path d="m8 18 1.5-8" />
      </motion.g>
      <motion.circle
        cx="12"
        cy="6"
        r="4"
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        variants={HEAD_VARIANTS}
      />
    </IconShell>
  )
}
