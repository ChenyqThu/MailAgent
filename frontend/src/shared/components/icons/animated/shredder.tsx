// lucide-animated · shredder。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×2；时长收敛 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PAPER_PATH: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, 1.5, -1.5, 1, -1, 0.5, -0.5, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SHRED_PATH_VARIANTS: Variants = {
  normal: { y: 0, opacity: 1 },
  animate: (custom: number) => ({
    y: 3,
    opacity: [0, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, delay: 0.2 * custom, type: 'tween' as const }
  })
}

export function ShredderIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g variants={PAPER_PATH}>
        <path d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      </motion.g>
      <motion.path custom={0.2} d="M10 22v-5" variants={SHRED_PATH_VARIANTS} />
      <motion.path custom={0.4} d="M14 19v-2" variants={SHRED_PATH_VARIANTS} />
      <motion.path custom={0.6} d="M18 20v-3" variants={SHRED_PATH_VARIANTS} />
      <path d="M2 13h20" />
      <motion.path d="M6 20v-3" variants={SHRED_PATH_VARIANTS} />
    </IconShell>
  )
}
