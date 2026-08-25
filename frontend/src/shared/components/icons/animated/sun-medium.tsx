// lucide-animated · sun-medium。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function SunMediumIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="4" />
      {[
        'M12 3v1',
        'M12 20v1',
        'M3 12h1',
        'M20 12h1',
        'm18.364 5.636-.707.707',
        'm6.343 17.657-.707.707',
        'm5.636 5.636.707.707',
        'm17.657 17.657.707.707'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
