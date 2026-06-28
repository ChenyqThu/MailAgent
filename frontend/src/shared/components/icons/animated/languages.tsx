// lucide-animated · languages（路径逐条描入，交错延迟）。源 pqoqubbw/icons，改造：spring bounce→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1, pathOffset: 0 },
  animate: (custom: number) => ({
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      opacity: { type: 'tween' as const, duration: 0.01, delay: custom * 0.1 },
      pathLength: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE, delay: custom * 0.1 },
      pathOffset: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE, delay: custom * 0.1 }
    }
  })
}

export function LanguagesIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={PATH_VARIANTS} custom={3} d="m5 8 6 6" />
      <motion.path variants={PATH_VARIANTS} custom={2} d="m4 14 6-6 3-3" />
      <motion.path variants={PATH_VARIANTS} custom={1} d="M2 5h12" />
      <motion.path variants={PATH_VARIANTS} custom={0} d="M7 2h1" />
      <motion.path variants={PATH_VARIANTS} custom={3} d="m22 22-5-10-5 10" />
      <motion.path variants={PATH_VARIANTS} custom={3} d="M14 18h6" />
    </IconShell>
  )
}
