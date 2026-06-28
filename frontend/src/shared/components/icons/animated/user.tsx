// lucide-animated · user（头 + 身依次描入）。源 pqoqubbw/icons，改造：
// 去 forwardRef/div 外壳 + 显式 tween + ICON_EASE（§10）。pathLength/pathOffset 描入保留。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD: Variants = {
  normal: { pathLength: 1, pathOffset: 0, scale: 1 },
  animate: {
    pathLength: [0, 1],
    pathOffset: [1, 0],
    scale: [0.5, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}
const BODY: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: 0.2 }
  }
}

export function UserIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle variants={HEAD} cx="12" cy="8" r="5" />
      <motion.path variants={BODY} d="M20 21a8 8 0 0 0-16 0" />
    </IconShell>
  )
}
