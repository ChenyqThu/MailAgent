// lucide-animated · send（信封飞出）。源 pqoqubbw/icons，改造：
// 去 forwardRef/controls/div 外壳；spring → tween + ICON_EASE（§10）。
// 装饰性虚线轨迹 path（strokeDasharray="2 2" + pathLength）已删 —— 在 15px 小图标太细碎。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const GROUP_VARIANTS = {
  normal: { x: 0, y: 0, scale: 1 },
  animate: { x: 3, y: -3, scale: 0.8 }
}

export function SendIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        variants={GROUP_VARIANTS}
        transition={{ type: 'tween', duration: 0.4, ease: ICON_EASE }}
      >
        <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
        <path d="m21.854 2.147-10.94 10.939" />
      </motion.g>
    </IconShell>
  )
}
