// lucide-animated · link-2。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LEFT_VARIANTS: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, -0.7, 0.3, 0],
    transition: { duration: 0.6, times: [0, 0.4, 0.75, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const RIGHT_VARIANTS: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, 0.7, -0.3, 0],
    transition: { duration: 0.6, times: [0, 0.4, 0.75, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function Link2Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g variants={LEFT_VARIANTS}>
        <path d="M9 17H7A5 5 0 0 1 7 7h2" />
        <line x1="8" x2="12" y1="12" y2="12" />
      </motion.g>
      <motion.g variants={RIGHT_VARIANTS}>
        <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
        <line x1="16" x2="12" y1="12" y2="12" />
      </motion.g>
    </IconShell>
  )
}
