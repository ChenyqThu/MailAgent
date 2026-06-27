// lucide-animated · bot（眼睛竖线收缩闪烁）。源 pqoqubbw/icons，改造：
// ease:'easeInOut' → ICON_EASE；去 forwardRef/controls/div 外壳；variant 名已是 normal/animate。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const EYE_VARIANTS: Variants = {
  normal: { y1: 13, y2: 15 },
  animate: {
    y1: [13, 14, 13],
    y2: [15, 14, 15],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: 0.2 }
  }
}

export function BotIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M12 8V4H8" />
      <rect height="12" rx="2" width="16" x="4" y="8" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <motion.line variants={EYE_VARIANTS} x1={15} x2={15} />
      <motion.line variants={EYE_VARIANTS} x1={9} x2={9} />
    </IconShell>
  )
}
