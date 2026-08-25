// lucide-animated · wifi-sync。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SYNC_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: -360 } }

const SYNC_TRANSITION: Transition = { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }

export function WifiSyncIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.86a10 10 0 0 1 3-2.032" />
      <path d="M8.5 16.429h.01" />
      <motion.g transition={SYNC_TRANSITION} variants={SYNC_VARIANTS}>
        <path d="M11.965 10.105v4L13.5 12.5a5 5 0 0 1 8 1.5" />
        <path d="M11.965 14.105h4" />
        <path d="M17.965 18.105h4L20.43 19.71a5 5 0 0 1-8-1.5" />
        <path d="M21.965 22.105v-4" />
      </motion.g>
    </IconShell>
  )
}
