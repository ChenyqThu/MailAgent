// lucide-animated · feather（羽毛轻摆）。源 pqoqubbw/icons，改造：去 forwardRef/controls/
// div 外壳；ease easeInOut → ICON_EASE；duration 1.6→0.6 收敛（§10）。svg 级整体变换。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: 0, y: 0, x: 0 },
  animate: {
    rotate: [0, -8, 4, -3, 0],
    y: [0, -4, -2, -1, 0],
    x: [0, 2, -2, 1, 0]
  }
}

export function FeatherIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.6, ease: ICON_EASE }}
    >
      <path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z" />
      <path d="M16 8 2 22" />
      <path d="M17.5 15H9" />
    </IconShell>
  )
}
