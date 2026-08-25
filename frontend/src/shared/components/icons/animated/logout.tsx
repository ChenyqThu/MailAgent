// lucide-animated · logout。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  animate: {
    x: 2,
    translateX: [0, -3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function LogoutIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <motion.polyline points="16 17 21 12 16 7" variants={PATH_VARIANTS} />
      <motion.line variants={PATH_VARIANTS} x1="21" x2="9" y1="12" y2="12" />
    </IconShell>
  )
}
