// lucide-animated · bookmark-x。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

const X_LINE_VARIANTS: Variants = {
  normal: { strokeDashoffset: 0, opacity: 1 },
  animate: (i: number) => ({
    strokeDashoffset: [1, 0],
    opacity: 1,
    transition: { duration: 0.3, ease: ICON_EASE, delay: i * 0.1, type: 'tween' as const }
  })
}

export function BookmarkXIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"
        style={{ originX: 0.5, originY: 0.5 }}
        variants={BOOKMARK_VARIANTS}
      />

      <motion.path
        custom={0}
        d="m14.5 7.5-5 5"
        pathLength="1"
        strokeDasharray="1 1"
        variants={X_LINE_VARIANTS}
      />

      <motion.path
        custom={1}
        d="m9.5 7.5 5 5"
        pathLength="1"
        strokeDasharray="1 1"
        variants={X_LINE_VARIANTS}
      />
    </IconShell>
  )
}
