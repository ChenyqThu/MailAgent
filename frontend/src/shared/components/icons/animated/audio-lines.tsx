// lucide-animated · audio-lines。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×4；时长收敛 ×3。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function AudioLinesIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 10v3" />
      <motion.path
        d="M6 6v11"
        variants={{
          normal: { d: 'M6 6v11' },
          animate: {
            d: ['M6 6v11', 'M6 10v3', 'M6 6v11'],
            transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M10 3v18"
        variants={{
          normal: { d: 'M10 3v18' },
          animate: {
            d: ['M10 3v18', 'M10 9v5', 'M10 3v18'],
            transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M14 8v7"
        variants={{
          normal: { d: 'M14 8v7' },
          animate: {
            d: ['M14 8v7', 'M14 6v11', 'M14 8v7'],
            transition: { duration: 0.8, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="M18 5v13"
        variants={{
          normal: { d: 'M18 5v13' },
          animate: {
            d: ['M18 5v13', 'M18 7v9', 'M18 5v13'],
            transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
      />
      <path d="M22 10v3" />
    </IconShell>
  )
}
