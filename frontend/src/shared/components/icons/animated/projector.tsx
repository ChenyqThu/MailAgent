// lucide-animated · projector。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RAY_LINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [1, 0, 1],
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const PROJECTOR_BODY_VARIANTS: Variants = {
  normal: { scale: 1, y: 0 },
  animate: {
    scale: [1, 1.08, 1],
    y: [0, -1, 0],
    transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function ProjectorIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M5 7 3 5" variants={RAY_LINE_VARIANTS} />
      <motion.path d="M9 6V3" variants={RAY_LINE_VARIANTS} />
      <motion.path d="m13 7 2-2" variants={RAY_LINE_VARIANTS} />
      <motion.g variants={PROJECTOR_BODY_VARIANTS}>
        <circle cx="9" cy="13" r="3" />
        <path d="M11.83 12H20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2.17" />
        <path d="M16 16h2" />
      </motion.g>
    </IconShell>
  )
}
