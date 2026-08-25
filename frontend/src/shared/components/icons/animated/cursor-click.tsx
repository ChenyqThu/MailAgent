// lucide-animated · cursor-click。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×1；时长收敛 ×1；variant 标签重命名。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CURSOR_VARIANTS: Variants = {
  normal: { x: 0, y: 0 },
  animate: {
    x: [0, 0, -3, 0],
    y: [0, -4, 0, 0],
    transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
  }
}

const LINE_VARIANTS: Variants = {
  normal: { opacity: 1, x: 0, y: 0 },
  animate: (custom: { x: number; y: number }) => ({
    opacity: [0, 1, 0, 0, 0, 0, 1],
    x: [0, custom.x, 0, 0],
    y: [0, custom.y, 0, 0],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  })
}

export function CursorClickIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"
        variants={CURSOR_VARIANTS}
      />
      <motion.path custom={{ x: 1, y: -1 }} d="M14 4.1 12 6" variants={LINE_VARIANTS} />
      <motion.path custom={{ x: -1, y: 0 }} d="m5.1 8-2.9-.8" variants={LINE_VARIANTS} />
      <motion.path custom={{ x: -1, y: 1 }} d="m6 12-1.9 2" variants={LINE_VARIANTS} />
      <motion.path custom={{ x: 0, y: -1 }} d="M7.2 2.2 8 5.1" variants={LINE_VARIANTS} />
    </IconShell>
  )
}
