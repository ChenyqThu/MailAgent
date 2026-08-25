// lucide-animated · message-square-dashed。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function MessageSquareDashedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {[
        'M14 3h1',
        'M14 17h1',
        'M10 17H7l-4 4v-7',
        'M9 3h1',
        'M19 3a2 2 0 0 1 2 2',
        'M3 9v1',
        'M21 9v1',
        'M21 14v1a2 2 0 0 1-2 2',
        'M5 3a2 2 0 0 0-2 2'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
