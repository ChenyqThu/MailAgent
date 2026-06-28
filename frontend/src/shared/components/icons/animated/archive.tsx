// lucide-animated · archive（盖子上抬 + 盒体+横线下移）。源 pqoqubbw/icons，改造：spring（stiffness/damping）→tween + ICON_EASE（§10）；去 forwardRef/div 外壳。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RECT_VARIANTS: Variants = {
  normal: {
    translateY: 0,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: {
    translateY: -1.5,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const PATH_VARIANTS: Variants = {
  normal: { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' },
  animate: {
    d: 'M4 11v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11',
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const LINE_VARIANTS: Variants = {
  normal: { d: 'M10 12h4' },
  animate: {
    d: 'M10 15h4',
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function ArchiveIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect variants={RECT_VARIANTS} height="5" rx="1" width="20" x="2" y="3" />
      <motion.path variants={PATH_VARIANTS} d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <motion.path variants={LINE_VARIANTS} d="M10 12h4" />
    </IconShell>
  )
}
