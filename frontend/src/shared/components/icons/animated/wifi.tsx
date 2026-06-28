// lucide-animated · wifi（信号弧线交错闪入）。源 pqoqubbw/icons，改造：
// 原双阶段 async fadeOut→fadeIn 简化为单次 animate：opacity [1,0,1] stagger（§10）；
// spring → tween + ICON_EASE；去 forwardRef/controls/div 外壳。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARCS = [
  { d: 'M12 20h.01', delay: 0 },
  { d: 'M8.5 16.429a5 5 0 0 1 7 0', delay: 0.1 },
  { d: 'M5 12.859a10 10 0 0 1 14 0', delay: 0.2 },
  { d: 'M2 8.82a15 15 0 0 1 20 0', delay: 0.3 }
]

export function WifiIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {ARCS.map((arc, i) => (
        <motion.path
          key={i}
          d={arc.d}
          variants={{
            normal: { opacity: 1 },
            animate: {
              opacity: [1, 0, 1],
              transition: { type: 'tween', duration: 0.5, ease: ICON_EASE, delay: arc.delay }
            }
          }}
        />
      ))}
    </IconShell>
  )
}
