// lucide-animated · x。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function XIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M18 6 6 18" variants={PATH_VARIANTS} />
      <motion.path
        d="m6 6 12 12"
        transition={{ delay: 0.2, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
    </IconShell>
  )
}
