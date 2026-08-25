// lucide-animated · users。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { translateX: 0, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } },
  animate: {
    translateX: [-6, 0],
    transition: { delay: 0.1, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function UsersIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <motion.path d="M22 21v-2a4 4 0 0 0-3-3.87" variants={PATH_VARIANTS} />
      <motion.path d="M16 3.13a4 4 0 0 1 0 7.75" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
