// lucide-animated · sunset。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARROW_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: { y: [0, 1, 0], transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } }
}

const RAYS_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function SunsetIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g variants={ARROW_VARIANTS}>
        <path d="M12 10V2" />
        <path d="m16 6-4 4-4-4" />
      </motion.g>

      {['m4.93 10.93 1.41 1.41', 'M2 18h2', 'M20 18h2', 'm19.07 10.93-1.41 1.41', 'M22 22H2'].map(
        (d, index) => (
          <motion.path custom={index + 1} d={d} key={d} variants={RAYS_VARIANTS} />
        )
      )}
      <path d="M16 18a4 4 0 0 0-8 0" />
    </IconShell>
  )
}
