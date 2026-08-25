// lucide-animated · github（轮廓描入 + 尾巴摆一下）。源 pqoqubbw/icons（MIT，见
// ./LICENSE-pqoqubbw），**人工改造**（批量脚本转不了：上游把尾巴拆成 draw → wag 两段
// await 序列，第二段是 `repeat: Infinity` 的永动摆尾）。本仓合成一次性播放：描入与摆尾
// 并成一条 animate 关键帧，摆幅收敛、只播一遍（§10 红线：不留常驻 rAF）。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BODY_VARIANTS: Variants = {
  normal: { opacity: 1, pathLength: 1, scale: 1 },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    scale: [0.9, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const TAIL_VARIANTS: Variants = {
  normal: { pathLength: 1, rotate: 0 },
  animate: {
    pathLength: [0, 1, 1, 1, 1],
    rotate: [0, 0, -12, 8, 0],
    transition: { type: 'tween' as const, duration: 0.8, ease: ICON_EASE }
  }
}

export function GithubIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={BODY_VARIANTS}
        d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"
      />
      <motion.path
        variants={TAIL_VARIANTS}
        style={{ transformBox: 'fill-box', transformOrigin: '100% 50%' }}
        d="M9 18c-4.51 2-5-2-7-2"
      />
    </IconShell>
  )
}
