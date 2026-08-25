// lucide-animated · soup。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SOUP_PATH_VARIANTS: Variants = {
  normal: { y: 0, opacity: 1 },
  animate: (custom: number) => ({
    y: -3,
    opacity: [0, 1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, delay: 0.2 * custom, type: 'tween' as const }
  })
}

export function SoupIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M12 21a9 9 0 0 0 9-9H3a9 9 0 0 0 9 9Z" />
      <path d="M7 21h10" />
      <path d="M19.5 12 22 6" />
      <motion.path
        custom={0}
        d="M16.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.73 1.62"
        variants={SOUP_PATH_VARIANTS}
      />
      <motion.path
        custom={0.2}
        d="M11.25 3c.27.1.8.53.74 1.36-.05.83-.93 1.2-.98 2.02-.06.78.33 1.24.72 1.62"
        variants={SOUP_PATH_VARIANTS}
      />
      <motion.path
        custom={0.4}
        d="M6.25 3c.27.1.8.53.75 1.36-.06.83-.93 1.2-1 2.02-.05.78.34 1.24.74 1.62"
        variants={SOUP_PATH_VARIANTS}
      />
    </IconShell>
  )
}
