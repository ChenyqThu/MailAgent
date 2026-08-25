// lucide-animated · file-pen-line。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PEN_VARIANTS: Variants = {
  normal: { rotate: 0, x: 0, y: 0 },
  animate: {
    rotate: [-0.3, 0.2, -0.4],
    x: [0, -0.5, 1, 0],
    y: [0, 1, -0.5, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function FilePenLineIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2" />
      <motion.path
        d="M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"
        variants={PEN_VARIANTS}
      />
      <motion.path
        d="M8 18h1"
        transition={{ duration: 0.5, type: 'tween' as const, ease: ICON_EASE }}
        variants={{ normal: { d: 'M8 18h1' }, animate: { d: 'M8 18h5' } }}
      />
    </IconShell>
  )
}
