// lucide-animated · user-round-cog（右下齿轮 hover 旋转 180°）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳；stroke-linecap/linejoin 改 camelCase。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const COG: Variants = {
  normal: {
    rotate: 0,
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  },
  animate: {
    rotate: 180,
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

export function UserRoundCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 21a8 8 0 0 1 10.434-7.62" />
      <circle cx="10" cy="8" r="5" />
      <motion.g variants={COG} style={{ transformOrigin: '18px 18px' }}>
        <circle cx="18" cy="18" r="3" />
        <path d="m14.305 19.53.923-.382" />
        <path d="m15.228 16.852-.923-.383" />
        <path d="m16.852 15.228-.383-.923" />
        <path d="m16.852 20.772-.383.924" />
        <path d="m19.148 15.228.383-.923" />
        <path d="m19.53 21.696-.382-.924" />
        <path d="m20.772 16.852.924-.383" />
        <path d="m20.772 19.148.924.383" />
      </motion.g>
    </IconShell>
  )
}
