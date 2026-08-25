// lucide-animated · sun-dim。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function SunDimIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="4" />
      {[
        'M12 4h.01',
        'M20 12h.01',
        'M12 20h.01',
        'M4 12h.01',
        'M17.657 6.343h.01',
        'M17.657 17.657h.01',
        'M6.343 17.657h.01',
        'M6.343 6.343h.01'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
