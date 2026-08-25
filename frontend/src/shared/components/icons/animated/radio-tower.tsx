// lucide-animated · radio-tower。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: i * 0.1 }
  })
}

export function RadioTowerIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={1} d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9" variants={VARIANTS} />
      <motion.path custom={0} d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5" variants={VARIANTS} />
      <circle cx="12" cy="9" r="2" />
      <motion.path custom={0} d="M16.2 4.8c2 2 2.26 5.11.8 7.47" variants={VARIANTS} />
      <motion.path custom={1} d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1" variants={VARIANTS} />
      <path d="M9.5 18h5" />
      <path d="m8 22 4-11 4 11" />
    </IconShell>
  )
}
