// lucide-animated · menu。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: { rotate: 0, y: 0, opacity: 1 },
  animate: (custom: number) => ({
    rotate: custom === 1 ? 45 : custom === 3 ? -45 : 0,
    y: custom === 1 ? 6 : custom === 3 ? -6 : 0,
    opacity: custom === 2 ? 0 : 1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  })
}

export function MenuIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.line custom={1} variants={LINE_VARIANTS} x1="4" x2="20" y1="6" y2="6" />
      <motion.line custom={2} variants={LINE_VARIANTS} x1="4" x2="20" y1="12" y2="12" />
      <motion.line custom={3} variants={LINE_VARIANTS} x1="4" x2="20" y1="18" y2="18" />
    </IconShell>
  )
}
