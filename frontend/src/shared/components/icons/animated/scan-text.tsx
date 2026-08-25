// lucide-animated · scan-text。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const FRAME_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 1, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const LINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [1, 0, 1],
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

export function ScanTextIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M3 7V5a2 2 0 0 1 2-2h2" variants={FRAME_VARIANTS} />
      <motion.path d="M17 3h2a2 2 0 0 1 2 2v2" variants={FRAME_VARIANTS} />
      <motion.path d="M21 17v2a2 2 0 0 1-2 2h-2" variants={FRAME_VARIANTS} />
      <motion.path d="M7 21H5a2 2 0 0 1-2-2v-2" variants={FRAME_VARIANTS} />
      <motion.path custom={0} d="M7 8h8" variants={LINE_VARIANTS} />
      <motion.path custom={1} d="M7 12h10" variants={LINE_VARIANTS} />
      <motion.path custom={2} d="M7 16h6" variants={LINE_VARIANTS} />
    </IconShell>
  )
}
