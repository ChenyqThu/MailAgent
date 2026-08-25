// lucide-animated · git-commit-horizontal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      delay: 0.15 * custom,
      opacity: { delay: 0.1 * custom, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function GitCommitHorizontalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle custom={1} cx="12" cy="12" r="3" variants={VARIANTS} />
      <motion.line custom={0} variants={VARIANTS} x1="3" x2="9" y1="12" y2="12" />
      <motion.line custom={2} variants={VARIANTS} x1="15" x2="21" y1="12" y2="12" />
    </IconShell>
  )
}
