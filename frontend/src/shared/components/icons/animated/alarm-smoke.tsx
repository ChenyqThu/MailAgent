// lucide-animated · alarm-smoke。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×2；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ALARM_VARIANTS: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.05, 1],
    transition: { duration: 0.5, ease: ICON_EASE, delay: 0.2, type: 'tween' as const }
  }
}

const SMOKE_VARIANTS: Variants = {
  normal: { y: 0, opacity: 1 },
  animate: {
    y: [6, 0],
    opacity: [0, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function AlarmSmokeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.path d="M11 21c0-2.5 2-2.5 2-5" variants={SMOKE_VARIANTS} />
      <motion.path d="M16 21c0-2.5 2-2.5 2-5" variants={SMOKE_VARIANTS} />
      <motion.g variants={ALARM_VARIANTS}>
        <motion.path d="m19 8-.8 3a1.25 1.25 0 0 1-1.2 1H7a1.25 1.25 0 0 1-1.2-1L5 8" />
        <motion.path d="M21 3a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z" />
      </motion.g>
      <motion.path d="M6 21c0-2.5 2-2.5 2-5" variants={SMOKE_VARIANTS} />
    </IconShell>
  )
}
