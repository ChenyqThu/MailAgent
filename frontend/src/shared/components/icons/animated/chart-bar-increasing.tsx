// lucide-animated · chart-bar-increasing。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [1, 0, 1],
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

export function ChartBarIncreasingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <motion.path custom={1} d="M7 11h8" variants={LINE_VARIANTS} />
      <motion.path custom={2} d="M7 16h12" variants={LINE_VARIANTS} />
      <motion.path custom={0} d="M7 6h3" variants={LINE_VARIANTS} />
    </IconShell>
  )
}
