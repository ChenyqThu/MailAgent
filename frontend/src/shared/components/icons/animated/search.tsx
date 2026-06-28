// lucide-animated · search（放大镜整体弹跳搜索）。源 pqoqubbw/icons，改造：svg 级整体变换 + ICON_EASE（§10）；bounce→tween；duration 1→0.5 收敛；去 forwardRef/div 外壳。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { x: 0, y: 0 },
  animate: {
    x: [0, 0, -3, 0],
    y: [0, -4, 0, 0]
  }
}

export function SearchIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </IconShell>
  )
}
