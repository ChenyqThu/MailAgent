// lucide-animated · workflow。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = {
  duration: 0.3,
  opacity: { delay: 0.15 }
}

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      ...TRANSITION,
      delay: 0.1 * custom,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function WorkflowIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect custom={0} height="8" rx="2" variants={VARIANTS} width="8" x="3" y="3" />
      <motion.path custom={3} d="M7 11v4a2 2 0 0 0 2 2h4" variants={VARIANTS} />
      <motion.rect custom={0} height="8" rx="2" variants={VARIANTS} width="8" x="13" y="13" />
    </IconShell>
  )
}
