// lucide-animated · eye。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function EyeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
        style={{ originY: '50%' }}
        transition={{ duration: 0.4, ease: ICON_EASE, type: 'tween' as const }}
        variants={{
          normal: { scaleY: 1, opacity: 1 },
          animate: { scaleY: [1, 0.1, 1], opacity: [1, 0.3, 1] }
        }}
      />
      <motion.circle
        cx="12"
        cy="12"
        r="3"
        transition={{ duration: 0.4, ease: ICON_EASE, type: 'tween' as const }}
        variants={{
          normal: { scale: 1, opacity: 1 },
          animate: { scale: [1, 0.3, 1], opacity: [1, 0.3, 1] }
        }}
      />
    </IconShell>
  )
}
