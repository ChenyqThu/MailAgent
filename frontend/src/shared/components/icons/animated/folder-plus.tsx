// lucide-animated · folder-plus（加号描线交错浮现）。源 pqoqubbw/icons，改造：
// ease easeInOut → ICON_EASE；去 forwardRef/controls/div 外壳。pathLength + custom stagger 保留。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PLUS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE, delay: custom * 0.1 }
  })
}

export function FolderPlusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <motion.path variants={PLUS} custom={1} d="M12 10v6" />
      <motion.path variants={PLUS} custom={0} d="M9 13h6" />
    </IconShell>
  )
}
