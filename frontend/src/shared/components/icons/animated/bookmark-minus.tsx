// lucide-animated · bookmark-minus。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BOOKMARK_VARIANTS: Variants = {
  normal: { scaleY: 1, scaleX: 1 },
  animate: {
    scaleY: [1, 1.3, 0.9, 1.05, 1],
    scaleX: [1, 0.9, 1.1, 0.95, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const MINUS_VARIANTS: Variants = {
  normal: { strokeDashoffset: 0, opacity: 1 },
  animate: {
    strokeDashoffset: [1, 0],
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function BookmarkMinusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
        style={{ originX: 0.5, originY: 0.5 }}
        variants={BOOKMARK_VARIANTS}
      />

      <motion.line
        pathLength="1"
        strokeDasharray="1 1"
        variants={MINUS_VARIANTS}
        x1="15"
        x2="9"
        y1="10"
        y2="10"
      />
    </IconShell>
  )
}
