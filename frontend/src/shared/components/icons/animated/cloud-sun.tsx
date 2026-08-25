// lucide-animated · cloud-sun。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CLOUD_VARIANTS: Variants = {
  normal: { x: 0, y: 0 },
  animate: {
    x: [-1, 1, -1, 1, 0],
    y: [-1, 1, -1, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SUN_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function CloudSunIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g variants={CLOUD_VARIANTS}>
        <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
      </motion.g>
      {[
        'M12 2v2',
        'm4.93 4.93 1.41 1.41',
        'M20 12h2',
        'm19.07 4.93-1.41 1.41',
        'M15.947 12.65a4 4 0 0 0-5.925-4.128'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={SUN_VARIANTS} />
      ))}
    </IconShell>
  )
}
