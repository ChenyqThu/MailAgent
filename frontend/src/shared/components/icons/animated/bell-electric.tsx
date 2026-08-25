// lucide-animated · bell-electric。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×2。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function BellElectricIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { rotate: 0, translateX: 0, translateY: 0 },
        animate: {
          rotate: [0, -12, 12, -8, 8, 0],
          translateX: [0, -1.5, 1.5, -1, 1, 0],
          translateY: [0, -1, 1, -0.5, 0.5, 0]
        }
      }}
      svgTransition={{ duration: 0.6, type: 'tween' as const, ease: ICON_EASE }}
      svgStyle={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
    >
      <path d="M18.518 17.347A7 7 0 0 1 14 19" />
      <motion.path
        d="M18.8 4A11 11 0 0 1 20 9"
        style={{ transformBox: 'fill-box', originX: '50%', originY: '50%' }}
        transition={{ duration: 0.6, type: 'tween' as const, ease: ICON_EASE }}
        variants={{
          normal: { translateX: 0, translateY: 0, rotate: 0 },
          animate: {
            translateX: [0, -0.8, 0.8, -0.6, 0.6, 0],
            translateY: [0, -0.5, 0.5, -0.3, 0.3, 0],
            rotate: [0, -6, 6, -4, 4, 0]
          }
        }}
      />
      <motion.path
        d="M9 9h.01"
        style={{ transformBox: 'fill-box', originX: '50%', originY: '50%' }}
        transition={{ duration: 0.75, type: 'tween' as const, ease: ICON_EASE }}
        variants={{
          normal: { translateX: 0, translateY: 0, rotate: 0, scale: 1 },
          animate: {
            translateX: [0, -1.6, 1.6, -1.2, 1.2, 0],
            translateY: [0, -1.2, 1.2, -0.8, 0.8, 0],
            rotate: [0, -10, 10, -7, 7, 0],
            scale: [1, 1.08, 0.95, 1.06, 0.98, 1]
          }
        }}
      />
      <circle cx="9" cy="9" r="7" />
      <rect height="6" rx="2" width="10" x="4" y="16" />
      <circle cx="20" cy="16" r="2" />
    </IconShell>
  )
}
