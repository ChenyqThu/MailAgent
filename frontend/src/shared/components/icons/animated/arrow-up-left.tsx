// lucide-animated · arrow-up-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARROW_VARIANTS: Variants = {
  normal: { scale: 1, translateX: 0, translateY: 0 },
  animate: {
    scale: [1, 0.85, 1],
    translateX: [0, 4, 0],
    translateY: [0, 4, 0],
    originX: 0,
    originY: 0,
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function ArrowUpLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g variants={ARROW_VARIANTS}>
        <path d="M7 7H17" />
        <path d="M7 7V17" />
        <path d="M17 17L7 7" />
      </motion.g>
    </IconShell>
  )
}
