// lucide-animated · circle-help（问号左右摇摆）。源 pqoqubbw/icons，改造：
// 去 forwardRef/controls/div 外壳；ease:'easeInOut' → ICON_EASE（§10）。
// 整圆不动，仅内部 g（问号 + 点）摇摆。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: 0 },
  animate: { rotate: [0, -10, 10, -10, 0] }
}

export function CircleHelpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="10" />
      <motion.g variants={VARIANTS} transition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </motion.g>
    </IconShell>
  )
}
