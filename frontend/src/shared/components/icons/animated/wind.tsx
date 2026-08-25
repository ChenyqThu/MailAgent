// lucide-animated · wind。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: (custom: number) => ({
    pathLength: 1,
    opacity: 1,
    pathOffset: 0,
    transition: { duration: 0.3, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  }),
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: { duration: 0.5, ease: ICON_EASE, delay: custom, type: 'tween' as const }
  })
}

export function WindIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={0.2} d="M12.8 19.6A2 2 0 1 0 14 16H2" variants={PATH_VARIANTS} />
      <motion.path custom={0} d="M17.5 8a2.5 2.5 0 1 1 2 4H2" variants={PATH_VARIANTS} />
      <motion.path custom={0.4} d="M9.8 4.4A2 2 0 1 1 11 8H2" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
