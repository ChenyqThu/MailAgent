// lucide-animated · gallery-horizontal-end。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×2；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: {
    translateX: 0,
    opacity: 1,
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  },
  animate: (i: number) => ({
    translateX: [2 * i, 0],
    opacity: [0, 1],
    transition: { delay: 0.25 * (2 - i), type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  })
}

export function GalleryHorizontalEndIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={2} d="M6 5v14" variants={PATH_VARIANTS} />
      <motion.path custom={1} d="M2 7v10" variants={PATH_VARIANTS} />
      <rect height="18" rx="2" width="12" x="10" y="3" />
    </IconShell>
  )
}
