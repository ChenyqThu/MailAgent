// lucide-animated · gallery-thumbnails。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.15, duration: 0.2, type: 'tween' as const, ease: ICON_EASE }
  })
}

export function GalleryThumbnailsIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="14" rx="2" width="18" x="3" y="3" />
      {['M4 21h1', 'M9 21h1', 'M14 21h1', 'M19 21h1'].map((d, index) => (
        <motion.path custom={index + 1} d={d} key={d} variants={PATH_VARIANTS} />
      ))}
    </IconShell>
  )
}
