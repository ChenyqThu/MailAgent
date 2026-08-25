// lucide-animated · arrow-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { d: 'm12 19-7-7 7-7', translateX: 0 },
  animate: {
    d: 'm12 19-7-7 7-7',
    translateX: [0, 3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: 'M19 12H5' },
  animate: {
    d: ['M19 12H5', 'M19 12H10', 'M19 12H5'],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function ArrowLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="m12 19-7-7 7-7" variants={PATH_VARIANTS} />
      <motion.path d="M19 12H5" variants={SECOND_PATH_VARIANTS} />
    </IconShell>
  )
}
