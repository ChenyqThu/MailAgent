// lucide-animated · chart-no-axes-column-increasing。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function ChartNoAxesColumnIncreasingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={0} d="M6 20v-4" variants={LINE_VARIANTS} />
      <motion.path custom={1} d="M12 20v-10" variants={LINE_VARIANTS} />
      <motion.path custom={2} d="M18 20v-16" variants={LINE_VARIANTS} />
    </IconShell>
  )
}
