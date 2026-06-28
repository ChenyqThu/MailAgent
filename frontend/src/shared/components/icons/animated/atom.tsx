// lucide-animated · atom（轨道逐条描入，交错延迟）。源 pqoqubbw/icons，改造：easeInOut→ICON_EASE（§10）；去 forwardRef/div 外壳；duration 0.4 保留。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: (custom: number) => ({
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE, delay: custom }
  }),
  animate: (custom: number) => ({
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE, delay: custom }
  })
}

export function AtomIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle variants={PATH_VARIANTS} custom={0} cx="12" cy="12" r="1" />
      <motion.path
        variants={PATH_VARIANTS}
        custom={0.1}
        d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"
      />
      <motion.path
        variants={PATH_VARIANTS}
        custom={0.2}
        d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"
      />
    </IconShell>
  )
}
