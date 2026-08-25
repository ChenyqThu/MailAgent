// lucide-animated · id-card。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { duration: 0.3, delay: custom * 0.1, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function IdCardIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={2} d="M16 10h2" variants={VARIANTS} />
      <motion.path custom={2} d="M16 14h2" variants={VARIANTS} />
      <motion.path custom={0} d="M6.17 15a3 3 0 0 1 5.66 0" variants={VARIANTS} />
      <motion.circle custom={1} cx="9" cy="11" r="2" variants={VARIANTS} />
      <rect height="14" rx="2" width="20" x="2" y="5" />
    </IconShell>
  )
}
