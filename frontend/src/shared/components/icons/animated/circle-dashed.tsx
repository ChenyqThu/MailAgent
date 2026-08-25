// lucide-animated · circle-dashed。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function CircleDashedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {[
        'M10.1 2.182a10 10 0 0 1 3.8 0',
        'M13.9 21.818a10 10 0 0 1-3.8 0',
        'M17.609 3.721a10 10 0 0 1 2.69 2.7',
        'M2.182 13.9a10 10 0 0 1 0-3.8',
        'M20.279 17.609a10 10 0 0 1-2.7 2.69',
        'M21.818 10.1a10 10 0 0 1 0 3.8',
        'M3.721 6.391a10 10 0 0 1 2.7-2.69',
        'M6.391 20.279a10 10 0 0 1-2.69-2.7'
      ].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
