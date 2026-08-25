// lucide-animated · nfc。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: i * 0.1 }
  })
}

export function NfcIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path custom={0} d="M6 8.32a7.43 7.43 0 0 1 0 7.36" variants={PATH_VARIANTS} />
      <motion.path custom={1} d="M9.46 6.21a11.76 11.76 0 0 1 0 11.58" variants={PATH_VARIANTS} />
      <motion.path custom={2} d="M12.91 4.1a15.91 15.91 0 0 1 .01 15.8" variants={PATH_VARIANTS} />
      <motion.path custom={3} d="M16.37 2a20.16 20.16 0 0 1 0 20" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
