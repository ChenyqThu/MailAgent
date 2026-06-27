// lucide-animated · bell（整体左右摇铃）。源 pqoqubbw/icons，改造：
// ease:'easeInOut' → ICON_EASE；去 forwardRef/controls/div 外壳。keyframe 数组保留。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: 0 },
  animate: { rotate: [0, -10, 10, -10, 0] }
}

export function BellIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </IconShell>
  )
}
