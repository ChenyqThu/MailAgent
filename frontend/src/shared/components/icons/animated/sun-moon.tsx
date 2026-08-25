// lucide-animated · sun-moon。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SUN_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -5, 5, -2, 2, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const MOON_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function SunMoonIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g variants={SUN_VARIANTS}>
        <path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4" />
      </motion.g>
      {[
        'M12 2v2',
        'M12 20v2',
        'm4.9 4.9 1.4 1.4',
        'm17.7 17.7 1.4 1.4',
        'M2 12h2',
        'M20 12h2',
        'm6.3 17.7-1.4 1.4',
        'm19.1 4.9-1.4 1.4'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={MOON_VARIANTS} />
      ))}
    </IconShell>
  )
}
