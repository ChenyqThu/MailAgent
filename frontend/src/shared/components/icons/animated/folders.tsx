// lucide-animated · folders（前层文件夹滑出 + 后层淡出错位）。源 pqoqubbw/icons，改造：
// spring（stiffness/damping）→ 显式 tween + ICON_EASE（§10 禁 spring）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const FRONT: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: -2,
    translateY: 2,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}
const BACK: Variants = {
  normal: { translateX: 0, translateY: 0, opacity: 1, scale: 1 },
  animate: {
    translateX: 2,
    translateY: -2,
    opacity: 0,
    scale: 0.9,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function FoldersIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={FRONT}
        d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"
      />
      <motion.path variants={BACK} d="M2 8v11a2 2 0 0 0 2 2h14" />
    </IconShell>
  )
}
