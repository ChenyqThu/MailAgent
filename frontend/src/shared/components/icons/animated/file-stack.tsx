// lucide-animated · file-stack。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×3。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function FileStackIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M21 7h-3a2 2 0 0 1-2-2V2"
        variants={{
          normal: { translateX: 0, translateY: 0 },
          animate: {
            translateX: -4,
            translateY: 4,
            transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M21 6v6.5c0 .8-.7 1.5-1.5 1.5h-7c-.8 0-1.5-.7-1.5-1.5v-9c0-.8.7-1.5 1.5-1.5H17Z"
        variants={{
          normal: { translateX: 0, translateY: 0 },
          animate: {
            translateX: -4,
            translateY: 4,
            transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          }
        }}
      />
      <path d="M7 8v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H15" />
      <motion.path
        d="M3 12v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H11"
        variants={{
          normal: { translateX: 0, translateY: 0 },
          animate: {
            translateX: 4,
            translateY: -4,
            transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
          }
        }}
      />
    </IconShell>
  )
}
