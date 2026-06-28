// lucide-animated · blocks（小方块 hover 滑出左下）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BLOCK: Variants = {
  normal: {
    translateX: 0,
    translateY: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    translateX: -4,
    translateY: 4,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function BlocksIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
      <motion.path variants={BLOCK} d="M14 3h7v7h-7z" />
    </IconShell>
  )
}
