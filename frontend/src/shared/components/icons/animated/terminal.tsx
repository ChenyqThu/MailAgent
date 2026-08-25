// lucide-animated · terminal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0, 1],
    transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function TerminalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <polyline points="4 17 10 11 4 5" />
      <motion.line variants={LINE_VARIANTS} x1="12" x2="20" y1="19" y2="19" />
    </IconShell>
  )
}
