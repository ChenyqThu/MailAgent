// lucide-animated · refresh-cw（整体顺时针旋转）。源 pqoqubbw/icons，改造：
// spring(stiffness/damping) → 显式 tween + ICON_EASE（§10）；去 forwardRef/controls/div 外壳。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: '0deg' },
  animate: { rotate: '50deg' }
}

export function RefreshCwIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.4, ease: ICON_EASE }}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </IconShell>
  )
}
