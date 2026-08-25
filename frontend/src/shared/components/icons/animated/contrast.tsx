// lucide-animated · contrast。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANT: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: 180,
    transformOrigin: 'left center',
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function ContrastIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <motion.path d="M12 18a6 6 0 0 0 0-12v12z" variants={PATH_VARIANT} />
    </IconShell>
  )
}
