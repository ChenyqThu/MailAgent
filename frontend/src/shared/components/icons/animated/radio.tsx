// lucide-animated · radio（信号弧线交错闪入）。源 pqoqubbw/icons，改造：
// 原双阶段 async fadeOut→fadeIn 简化为单次 animate：opacity [1,0,1] stagger（§10）；
// spring → tween + ICON_EASE；去 forwardRef/controls/div 外壳。
// stagger 通过 motion custom prop + TargetResolver variant 函数实现。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARC_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (delay: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay }
  })
}

export function RadioIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={ARC_VARIANTS} custom={0.1} d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <motion.path variants={ARC_VARIANTS} custom={0} d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <motion.path variants={ARC_VARIANTS} custom={0} d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <motion.path variants={ARC_VARIANTS} custom={0.1} d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </IconShell>
  )
}
