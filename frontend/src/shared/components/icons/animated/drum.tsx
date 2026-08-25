// lucide-animated · drum。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: (custom: number) => ({
    rotate: custom === 1 ? [-10, 10, 0] : [10, -10, 0],
    transition: { delay: 0.1 * custom, duration: 0.5, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function DrumIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={1} d="m2 2 8 8" variants={VARIANTS} />
      <motion.path custom={2} d="m22 2-8 8" variants={VARIANTS} />
      <ellipse cx="12" cy="9" rx="10" ry="5" />
      <path d="M7 13.4v7.9" />
      <path d="M12 14v8" />
      <path d="M17 13.4v7.9" />
      <path d="M2 9v8a10 5 0 0 0 20 0V9" />
    </IconShell>
  )
}
