// lucide-animated · zap-off（各路径依次描入）。源 pqoqubbw/icons，改造：tween 保留 + ICON_EASE（§10）；去 forwardRef/div 外壳；duration 0.6→0.5 收敛。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  },
  animate: (custom: number) => ({
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      delay: custom,
      opacity: { type: 'tween' as const, duration: 0.1, delay: custom }
    }
  })
}

const PATHS = [
  'M10.513 4.856 13.12 2.17a.5.5 0 0 1 .86.46l-1.377 4.317',
  'M15.656 10H20a1 1 0 0 1 .78 1.63l-1.72 1.773',
  'M16.273 16.273 10.88 21.83a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14H4a1 1 0 0 1-.78-1.63l4.507-4.643',
  'm2 2 20 20'
]

export function ZapOffIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {PATHS.map((d, i) => (
        <motion.path key={i} variants={PATH_VARIANTS} custom={i * 0.1} d={d} />
      ))}
    </IconShell>
  )
}
