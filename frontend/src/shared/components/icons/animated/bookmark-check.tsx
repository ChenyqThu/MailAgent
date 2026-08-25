// lucide-animated · bookmark-check。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

const CHECK_VARIANTS: Variants = {
  normal: { opacity: 1, strokeDashoffset: 0 },
  animate: {
    strokeDashoffset: [1, 0],
    opacity: [0, 1],
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function BookmarkCheckIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"
        style={{ originX: 0.5, originY: 0.5 }}
        variants={BOOKMARK_VARIANTS}
      />

      <motion.path
        d="m9 10 2 2 4-4"
        pathLength="1"
        strokeDasharray="1 1"
        variants={CHECK_VARIANTS}
      />
    </IconShell>
  )
}
