// lucide-animated · cloud-sync。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SYNC_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: -360 } }

const SYNC_TRANSITION: Transition = { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }

export function CloudSyncIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M20.996 15.251A4.5 4.5 0 0 0 17.495 8h-1.79a7 7 0 1 0-12.709 5.607" />
      <motion.g transition={SYNC_TRANSITION} variants={SYNC_VARIANTS}>
        <path d="m17 18-1.535 1.605a5 5 0 0 1-8-1.5" />
        <path d="M17 22v-4h-4" />
        <path d="M7 10v4h4" />
        <path d="m7 14 1.535-1.605a5 5 0 0 1 8 1.5" />
      </motion.g>
    </IconShell>
  )
}
