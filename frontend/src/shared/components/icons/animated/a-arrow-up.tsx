// lucide-animated · a-arrow-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LETTER_VARIANTS: Variants = {
  normal: { opacity: 1, scale: 1 },
  animate: {
    opacity: [0, 1],
    scale: [0.8, 1],
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  }
}

const ARROW_VARIANTS: Variants = {
  normal: { opacity: 1, y: 0 },
  animate: {
    opacity: [0, 1],
    y: [10, 0],
    transition: { duration: 0.3, delay: 0.2, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function AArrowUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M3.5 13h6" variants={LETTER_VARIANTS} />
      <motion.path d="m2 16 4.5-9 4.5 9" variants={LETTER_VARIANTS} />

      <motion.path d="M18 16V7" variants={ARROW_VARIANTS} />
      <motion.path d="m14 11 4-4 4 4" variants={ARROW_VARIANTS} />
    </IconShell>
  )
}
