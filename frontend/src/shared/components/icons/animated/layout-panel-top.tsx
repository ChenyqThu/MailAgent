// lucide-animated · layout-panel-top。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function LayoutPanelTopIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect
        height="7"
        rx="1"
        variants={{
          normal: { opacity: 1, translateY: 0 },
          animate: {
            opacity: [0, 1],
            translateY: [-5, 0],
            transition: {
              opacity: { duration: 0.5, times: [0.2, 1], type: 'tween' as const, ease: ICON_EASE },
              duration: 0.5,
              type: 'tween' as const,
              ease: ICON_EASE
            }
          }
        }}
        width="18"
        x="3"
        y="3"
      />
      <motion.rect
        height="7"
        rx="1"
        variants={{
          normal: { opacity: 1, translateX: 0 },
          animate: {
            opacity: [0, 1],
            translateX: [-10, 0],
            transition: {
              opacity: { duration: 0.7, times: [0.5, 1], type: 'tween' as const, ease: ICON_EASE },
              translateX: { delay: 0.3, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
              duration: 0.5,
              type: 'tween' as const,
              ease: ICON_EASE
            }
          }
        }}
        width="7"
        x="3"
        y="14"
      />
      <motion.rect
        height="7"
        rx="1"
        variants={{
          normal: { opacity: 1, translateX: 0 },
          animate: {
            opacity: [0, 1],
            translateX: [10, 0],
            transition: {
              opacity: { duration: 0.8, times: [0.5, 1], type: 'tween' as const, ease: ICON_EASE },
              translateX: { delay: 0.4, type: 'tween' as const, duration: 0.4, ease: ICON_EASE },
              duration: 0.5,
              type: 'tween' as const,
              ease: ICON_EASE
            }
          }
        }}
        width="7"
        x="14"
        y="14"
      />
    </IconShell>
  )
}
