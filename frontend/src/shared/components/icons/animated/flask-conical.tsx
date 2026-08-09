// lucide FlaskConical 静止态 + hover 瓶身轻摆 / 液面描入。遵循 IconShell tween 红线。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BODY_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    rotate: [0, -8, 6, 0],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const LIQUID_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    pathLength: [0, 1],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function FlaskConicalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g variants={BODY_VARIANTS} style={{ transformOrigin: '12px 12px' }}>
        <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" />
        <motion.path variants={LIQUID_VARIANTS} d="M6.453 15h11.094" />
        <path d="M8.5 2h7" />
      </motion.g>
    </IconShell>
  )
}
