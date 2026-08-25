// lucide-animated · cloud-upload。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；variant 标签重命名。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CLOUD_VARIANTS: Variants = { normal: { y: 0 }, animate: { y: -2 } }

export function CloudUploadIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
      <motion.g
        transition={{ duration: 0.3, ease: ICON_EASE, type: 'tween' as const }}
        variants={CLOUD_VARIANTS}
      >
        <path d="M12 13v8" />
        <path d="m8 17 4-4 4 4" />
      </motion.g>
    </IconShell>
  )
}
