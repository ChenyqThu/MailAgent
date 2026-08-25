// lucide-animated · mic。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CAPSULE_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, -3, 0, -2, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function MicIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M12 19v3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <motion.rect height="13" rx="3" variants={CAPSULE_VARIANTS} width="6" x="9" y="2" />
    </IconShell>
  )
}
