// lucide-animated · chess-king。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const KING_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    y: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    rotate: [0, -10, 10, -6, 6, -2, 0],
    y: [0, -3, -3, -2, -2, -1, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.18, 0.38, 0.55, 0.7, 0.85, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

export function ChessKingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 22px' }}
        variants={KING_VARIANTS}
      >
        <path d="M4 20a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
        <path d="m6.7 18-1-1C4.35 15.682 3 14.09 3 12a5 5 0 0 1 4.95-5c1.584 0 2.7.455 4.05 1.818C13.35 7.455 14.466 7 16.05 7A5 5 0 0 1 21 12c0 2.082-1.359 3.673-2.7 5l-1 1" />
        <path d="M10 4h4" />
        <path d="M12 2v6.818" />
      </motion.g>
    </IconShell>
  )
}
