// lucide-animated · cast。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (custom: number) => ({
    opacity: [0, 1],
    transition: { delay: custom, duration: 0.5, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function CastIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <motion.path custom={0.2} d="M2 12a9 9 0 0 1 8 8" variants={VARIANTS} />
      <motion.path custom={0.1} d="M2 16a5 5 0 0 1 4 4" variants={VARIANTS} />
      <motion.line custom={0} variants={VARIANTS} x1="2" x2="2.01" y1="20" y2="20" />
    </IconShell>
  )
}
