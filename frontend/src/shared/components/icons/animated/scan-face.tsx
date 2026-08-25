// lucide-animated · scan-face。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const faceVariants: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 0.9, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const cornerVariants: Variants = {
  normal: { scale: 1, rotate: 0, opacity: 1 },
  animate: {
    scale: [1, 1.2, 1],
    rotate: [0, 45, 0],
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const mouthVariants: Variants = {
  normal: { scale: 1, opacity: 1 },
  animate: {
    scale: [1, 0.8, 1],
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: 0.1 }
  }
}

export function ScanFaceIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <motion.path d="M3 7V5a2 2 0 0 1 2-2h2" variants={cornerVariants} />
      <motion.path d="M17 3h2a2 2 0 0 1 2 2v2" variants={cornerVariants} />
      <motion.path d="M21 17v2a2 2 0 0 1-2 2h-2" variants={cornerVariants} />
      <motion.path d="M7 21H5a2 2 0 0 1-2-2v-2" variants={cornerVariants} />
      <motion.path d="M8 14s1.5 2 4 2 4-2 4-2" variants={mouthVariants} />
      <line x1="9" x2="9.01" y1="9" y2="9" />
      <line x1="15" x2="15.01" y1="9" y2="9" />
    </IconShell>
  )
}
