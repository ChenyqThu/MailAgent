// lucide-animated · login。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  animate: {
    x: -2,
    translateX: [0, 3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function LoginIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <motion.polyline points="10 17 15 12 10 7" variants={PATH_VARIANTS} />
      <motion.line variants={PATH_VARIANTS} x1="3" x2="15" y1="12" y2="12" />
    </IconShell>
  )
}
