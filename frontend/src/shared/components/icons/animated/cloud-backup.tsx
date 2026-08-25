// lucide-animated · cloud-backup。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BACKUP_VARIANTS: Variants = { normal: { rotate: 0 }, animate: { rotate: -360 } }

const BACKUP_TRANSITION: Transition = { duration: 0.8, ease: ICON_EASE, type: 'tween' as const }

export function CloudBackupIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M21 15.251A4.5 4.5 0 0 0 17.5 8h-1.79A7 7 0 1 0 3 13.607" />
      <motion.g transition={BACKUP_TRANSITION} variants={BACKUP_VARIANTS}>
        <path d="M7 11v4h4" />
        <path d="M8 19a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5 4.82 4.82 0 0 0-3.41 1.41L7 15" />
      </motion.g>
    </IconShell>
  )
}
