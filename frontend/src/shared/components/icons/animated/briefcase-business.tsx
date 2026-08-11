// lucide-animated · briefcase-business（提手上提后落回）。源 pqoqubbw/icons，改造：
// 仅动画提手以保证 15px 侧栏尺寸下清晰；spring→显式 tween + ICON_EASE（§10）；
// 去 forwardRef/useImperativeHandle/div 外壳，改由 IconShell 的 controls 递归驱动。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HANDLE_VARIANTS: Variants = {
  normal: {
    y: 0,
    scale: 1,
    transition: { type: 'tween' as const, duration: 0.38, ease: ICON_EASE }
  },
  animate: {
    y: [0, -1.5, 0],
    scale: [1, 1.04, 1],
    transition: { type: 'tween' as const, duration: 0.38, ease: ICON_EASE }
  }
}

export function BriefcaseBusinessIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M12 12h.01" />
      <motion.path
        variants={HANDLE_VARIANTS}
        style={{ transformOrigin: '12px 6px' }}
        d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"
      />
      <path d="M22 13a18.15 18.15 0 0 1-20 0" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </IconShell>
  )
}
