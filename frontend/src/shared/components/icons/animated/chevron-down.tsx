// lucide-animated · chevron-down（向下弹跳）。源 pqoqubbw/icons，改造：tween 保留 + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, 2, 0],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      times: [0, 0.4, 1]
    }
  }
}

export function ChevronDownIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={PATH_VARIANTS} d="m6 9 6 6 6-6" />
    </IconShell>
  )
}
