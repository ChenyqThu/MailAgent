// lucide-animated · message-circle-dashed。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function MessageCircleDashedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {[
        'M13.5 3.1c-.5 0-1-.1-1.5-.1s-1 .1-1.5.1',
        'M19.3 6.8a10.45 10.45 0 0 0-2.1-2.1',
        'M20.9 13.5c.1-.5.1-1 .1-1.5s-.1-1-.1-1.5',
        'M17.2 19.3a10.45 10.45 0 0 0 2.1-2.1',
        'M10.5 20.9c.5.1 1 .1 1.5.1s1-.1 1.5-.1',
        'M3.5 17.5 2 22l4.5-1.5',
        'M3.1 10.5c0 .5-.1 1-.1 1.5s.1 1 .1 1.5',
        'M6.8 4.7a10.45 10.45 0 0 0-2.1 2.1'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
