// lucide-animated · cooking-pot。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LID_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -14, 14, -10, 10, -6, 6, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const POT_VARIANTS: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.08, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function CookingPotIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g style={{ transformOrigin: '12px 16px' }} variants={POT_VARIANTS}>
        <path d="M2 12h20" />
        <path d="M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" />
      </motion.g>
      <motion.g style={{ transformOrigin: '18px 6px' }} variants={LID_VARIANTS}>
        <path d="m4 8 16-4" />
        <path d="m8.86 6.78-.45-1.81a2 2 0 0 1 1.45-2.43l1.94-.48a2 2 0 0 1 2.43 1.46l.45 1.8" />
      </motion.g>
    </IconShell>
  )
}
