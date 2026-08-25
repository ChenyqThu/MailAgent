// lucide-animated · file-text。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function FileTextIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { scale: 1 },
        animate: {
          scale: 1.05,
          transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
        }
      }}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />

      <motion.path
        d="M10 9H8"
        stroke="currentColor"
        strokeWidth="2"
        variants={{
          normal: { pathLength: 1, x1: 8, x2: 10 },
          animate: {
            pathLength: [1, 0, 1],
            x1: [8, 10, 8],
            x2: [10, 10, 10],
            transition: { duration: 0.7, delay: 0.3, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M16 13H8"
        stroke="currentColor"
        strokeWidth="2"
        variants={{
          normal: { pathLength: 1, x1: 8, x2: 16 },
          animate: {
            pathLength: [1, 0, 1],
            x1: [8, 16, 8],
            x2: [16, 16, 16],
            transition: { duration: 0.7, delay: 0.5, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M16 17H8"
        stroke="currentColor"
        strokeWidth="2"
        variants={{
          normal: { pathLength: 1, x1: 8, x2: 16 },
          animate: {
            pathLength: [1, 0, 1],
            x1: [8, 16, 8],
            x2: [16, 16, 16],
            transition: { duration: 0.7, delay: 0.7, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
    </IconShell>
  )
}
