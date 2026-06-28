// lucide-animated · check-check（双勾依次描入 + 缩放弹入）。源 pqoqubbw/icons，改造：tween 保留 + ICON_EASE 替换 easeInOut（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    scale: 1,
    transition: { type: 'tween' as const, duration: 0.3, ease: ICON_EASE }
  },
  animate: (custom: number) => ({
    opacity: [0, 1],
    pathLength: [0, 1],
    scale: [0.5, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      delay: 0.1 * custom,
      opacity: { type: 'tween' as const, duration: 0.1, delay: 0.1 * custom }
    }
  })
}

export function CheckCheckIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={PATH_VARIANTS} custom={0} d="M2 12 7 17L18 6" />
      <motion.path variants={PATH_VARIANTS} custom={1} d="M13 16L14.5 17.5L22 10" />
    </IconShell>
  )
}
