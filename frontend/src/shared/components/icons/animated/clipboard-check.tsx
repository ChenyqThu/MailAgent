// lucide-animated · clipboard-check。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CHECK_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 0,
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const },
      opacity: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

export function ClipboardCheckIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="4" rx="1" ry="1" width="8" x="8" y="2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <motion.path
        d="m9 14 2 2 4-4"
        style={{ transformOrigin: 'center' }}
        variants={CHECK_VARIANTS}
      />
    </IconShell>
  )
}
