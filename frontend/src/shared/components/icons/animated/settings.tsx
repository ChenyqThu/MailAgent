// lucide-animated · settings（齿轮 hover 旋转）。源 pqoqubbw/icons，改造：
// spring → 显式 tween + standard 曲线（motion-gsap.md §10）；rotate 180 → 120（克制）。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS = {
  normal: { rotate: 0 },
  animate: { rotate: 120 }
}

export function SettingsIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.5, ease: ICON_EASE }}
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </IconShell>
  )
}
