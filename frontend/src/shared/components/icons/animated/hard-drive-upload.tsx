// lucide-animated · hard-drive-upload。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const ARROW_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: { y: -1, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } }
}

export function HardDriveUploadIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="8" rx="2" width="20" x="2" y="14" />
      <path d="M6 18h.01" />
      <path d="M10 18h.01" />
      <motion.g variants={ARROW_VARIANTS}>
        <path d="m16 6-4-4-4 4" />
        <path d="M12 2v8" />
      </motion.g>
    </IconShell>
  )
}
