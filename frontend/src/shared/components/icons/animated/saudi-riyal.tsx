// lucide-animated · saudi-riyal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SAUDI_RIYAL_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      duration: 0.6,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function SaudiRiyalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="m20 19.5-5.5 1.2" variants={SAUDI_RIYAL_VARIANTS} />
      <motion.path d="M14.5 4v11.22a1 1 0 0 0 1.242.97L20 15.2" variants={SAUDI_RIYAL_VARIANTS} />
      <motion.path
        d="m2.978 19.351 5.549-1.363A2 2 0 0 0 10 16V2"
        variants={SAUDI_RIYAL_VARIANTS}
      />
      <motion.path d="M20 10 4 13.5" variants={SAUDI_RIYAL_VARIANTS} />
    </IconShell>
  )
}
