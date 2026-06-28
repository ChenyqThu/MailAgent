// lucide-animated · square-pen（画笔抖动写字）。源 pqoqubbw/icons，改造：
// 去 forwardRef/controls/div 外壳；variant 名已是 normal/animate，补显式 tween transition。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PEN_VARIANTS: Variants = {
  normal: { rotate: 0, x: 0, y: 0 },
  animate: {
    rotate: [-0.5, 0.5, -0.5],
    x: [0, -1, 1.5, 0],
    y: [0, 1.5, -1, 0],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function SquarePenIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <motion.path
        variants={PEN_VARIANTS}
        d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
      />
    </IconShell>
  )
}
