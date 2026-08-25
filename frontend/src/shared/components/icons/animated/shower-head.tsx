// lucide-animated · shower-head。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DROP_VARIANTS: Variants = {
  animate: {
    transition: { staggerChildren: 0.2, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const DROP_CHILD_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0.2, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const DROP_PATH = [
  { id: 'drop1', d: 'M14 17v.01' },
  { id: 'drop2', d: 'M10 16v.01' },
  { id: 'drop3', d: 'M13 13v.01' },
  { id: 'drop4', d: 'M16 10v.01' },
  { id: 'drop5', d: 'M11 20v.01' },
  { id: 'drop6', d: 'M17 14v.01' },
  { id: 'drop7', d: 'M20 11v.01' }
]

export function ShowerHeadIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m4 4 2.5 2.5" />
      <path d="M13.5 6.5a4.95 4.95 0 0 0-7 7" />
      <path d="M15 5 5 15" />
      <motion.g variants={DROP_VARIANTS}>
        {DROP_PATH.map((path) => (
          <motion.path d={path.d} key={path.id} variants={DROP_CHILD_VARIANTS} />
        ))}
      </motion.g>
    </IconShell>
  )
}
