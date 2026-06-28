// lucide-animated · history（箭头回转 + 时钟指针）。源 pqoqubbw/icons，改造：
// spring → 显式 tween + ICON_EASE（§10）；easeInOut → ICON_EASE；variant 名保持 normal/animate。
// 时针绕 originX/Y "0%" "100%" 旋转（近似圆心），分针单独绕自身原点转动。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARROW_VARIANTS = {
  normal: { rotate: '0deg' },
  animate: { rotate: '-50deg' }
}

const HAND_VARIANTS = {
  normal: { rotate: 0, originX: '0%', originY: '100%' },
  animate: { rotate: -360, originX: '0%', originY: '100%' }
}

const MINUTE_HAND_VARIANTS = {
  normal: { rotate: 0, originX: '0%', originY: '0%' },
  animate: { rotate: -45, originX: '0%', originY: '0%' }
}

export function HistoryIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        variants={ARROW_VARIANTS}
        transition={{ type: 'tween', duration: 0.4, ease: ICON_EASE }}
      >
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </motion.g>
      <motion.line
        variants={HAND_VARIANTS}
        transition={{ type: 'tween', duration: 0.6, ease: ICON_EASE }}
        x1="12"
        x2="12"
        y1="12"
        y2="7"
      />
      <motion.line
        variants={MINUTE_HAND_VARIANTS}
        transition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
        x1="12"
        x2="16"
        y1="12"
        y2="14"
      />
    </IconShell>
  )
}
