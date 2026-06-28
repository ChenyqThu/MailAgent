// lucide-animated · refresh-ccw（整体反转旋转）。源 pqoqubbw/icons，改造：spring（stiffness/damping）→tween + ICON_EASE（§10）；去 forwardRef/div 外壳；g 级旋转→svg 级 svgVariants。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: 0 },
  animate: { rotate: -50 }
}

export function RefreshCcwIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.4, ease: ICON_EASE }}
    >
      <path d="M3 2v6h6" />
      <path d="M21 12A9 9 0 0 0 6 5.3L3 8" />
      <path d="M21 22v-6h-6" />
      <path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
    </IconShell>
  )
}
