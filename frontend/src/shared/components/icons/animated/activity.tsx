// lucide-animated · activity（心电图路径绘入）。源 pqoqubbw/icons，改造：
// 去 forwardRef/controls/div 外壳；ease:'linear' → ICON_EASE；variant 名已是 normal/animate。
// pathOffset/pathLength 动画用显式 tween transition 覆盖（不依赖 spring 默认）。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: { type: 'tween' as const, duration: 0.6, ease: ICON_EASE }
  }
}

export function ActivityIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={VARIANTS}
        d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
      />
    </IconShell>
  )
}
