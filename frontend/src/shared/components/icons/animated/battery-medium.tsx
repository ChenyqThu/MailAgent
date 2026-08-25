// lucide-animated · battery-medium。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: i * 0.4 }
  })
}

export function BatteryMediumIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="10" rx="2" ry="2" width="16" x="2" y="7" />
      <line x1="22" x2="22" y1="11" y2="13" />
      <motion.line custom={0} variants={LINE_VARIANTS} x1="6" x2="6" y1="11" y2="13" />
      <motion.line custom={1} variants={LINE_VARIANTS} x1="10" x2="10" y1="11" y2="13" />
    </IconShell>
  )
}
