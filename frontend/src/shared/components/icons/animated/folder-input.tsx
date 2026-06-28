// lucide-animated · folder-input（箭头滑入文件夹）。源 pqoqubbw/icons，改造：
// ease/duration → ICON_EASE（§10）；去 forwardRef/div 外壳。箭头组用 motion.g 平移。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARROW: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, 2, 0],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, times: [0, 0.4, 1] }
  }
}

export function FolderInputIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
      <motion.g variants={ARROW}>
        <path d="M2 13h10" />
        <path d="m9 16 3-3-3-3" />
      </motion.g>
    </IconShell>
  )
}
