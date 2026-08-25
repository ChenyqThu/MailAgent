// lucide-animated · database-backup。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function DatabaseBackupIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 12a9 3 0 0 0 5 2.69" />
      <path d="M21 9.3V5" />
      <path d="M3 5v14a9 3 0 0 0 6.47 2.88" />

      <motion.g
        style={{ transformOrigin: '17.5px 17px' }}
        transition={{ duration: 0.6, ease: ICON_EASE, type: 'tween' as const }}
        variants={{ normal: { rotate: 0 }, animate: { rotate: 360 } }}
      >
        <path d="M12 12v4h4" />
        <path d="M13 20a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L12 16" />
      </motion.g>
    </IconShell>
  )
}
