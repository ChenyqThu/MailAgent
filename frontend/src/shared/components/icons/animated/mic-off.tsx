// lucide-animated · mic-off。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: {
      duration: 0.3,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      duration: 0.4,
      delay: 0.15,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function MicOffIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M12 19v3" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M16.95 16.95A7 7 0 0 1 5 12v-2" />
      <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <motion.path d="m2 2 20 20" variants={LINE_VARIANTS} />
    </IconShell>
  )
}
