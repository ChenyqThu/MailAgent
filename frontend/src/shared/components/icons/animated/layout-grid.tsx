// lucide-animated · layout-grid。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RECT_1_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [0, 11, 11, 0],
    translateY: [0, 0, 0, 0],
    transition: { duration: 0.8, ease: ICON_EASE, times: [0, 0.4, 0.6, 1], type: 'tween' as const }
  }
}

const RECT_2_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [0, 0, 0, 0],
    translateY: [0, 11, 11, 0],
    transition: { duration: 0.8, ease: ICON_EASE, times: [0, 0.4, 0.6, 1], type: 'tween' as const }
  }
}

const RECT_3_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [0, -11, -11, 0],
    translateY: [0, 0, 0, 0],
    transition: { duration: 0.8, ease: ICON_EASE, times: [0, 0.4, 0.6, 1], type: 'tween' as const }
  }
}

const RECT_4_VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: {
    translateX: [0, 0, 0, 0],
    translateY: [0, -11, -11, 0],
    transition: { duration: 0.8, ease: ICON_EASE, times: [0, 0.4, 0.6, 1], type: 'tween' as const }
  }
}

export function LayoutGridIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect height="7" rx="1" variants={RECT_1_VARIANTS} width="7" x="3" y="3" />
      <motion.rect height="7" rx="1" variants={RECT_2_VARIANTS} width="7" x="14" y="3" />
      <motion.rect height="7" rx="1" variants={RECT_3_VARIANTS} width="7" x="14" y="14" />
      <motion.rect height="7" rx="1" variants={RECT_4_VARIANTS} width="7" x="3" y="14" />
    </IconShell>
  )
}
