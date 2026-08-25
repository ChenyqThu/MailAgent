// lucide-animated · spray-can。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SPRAY_DOT_VARIANTS: Variants = {
  normal: { opacity: 1, transition: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE } },
  animate: (index: number) => ({
    opacity: [0, 1, 0],
    transition: {
      delay: index * 0.07,
      duration: 0.4,
      ease: ICON_EASE,
      times: [0, 0.45, 1],
      type: 'tween' as const
    }
  })
}

const DOT_PATHS_RTL = [
  { d: 'M11 7h.01', key: 'dot-3' },
  { d: 'M7 5h.01', key: 'dot-2' },
  { d: 'M7 9h.01', key: 'dot-5' },
  { d: 'M3 3h.01', key: 'dot-1' },
  { d: 'M3 7h.01', key: 'dot-4' },
  { d: 'M3 11h.01', key: 'dot-6' }
] as const

export function SprayCanIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="4" width="4" x="15" y="5" />
      <path d="m19 9 2 2v10c0 .6-.4 1-1 1h-6c-.6 0-1-.4-1-1V11l2-2" />
      <path d="m13 14 8-2" />
      <path d="m13 19 8-2" />
      <g>
        {DOT_PATHS_RTL.map((item, index) => (
          <motion.path custom={index} d={item.d} key={item.key} variants={SPRAY_DOT_VARIANTS} />
        ))}
      </g>
    </IconShell>
  )
}
