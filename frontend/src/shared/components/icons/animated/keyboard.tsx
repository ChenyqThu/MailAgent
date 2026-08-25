// lucide-animated · keyboard（按键依次闪一下）。源 pqoqubbw/icons（MIT，见
// ./LICENSE-pqoqubbw），**人工改造**（批量脚本转不了：上游用 useState + useEffect +
// AnimatePresence，且延时是 `i * 0.2 * Math.random()`）。本仓换成固定错峰的 variants
// resolver —— 随机延时每次渲染都不同、测不了也复现不了，固定错峰视觉上等价。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const KEYS = [
  'M10 8h.01',
  'M12 12h.01',
  'M14 8h.01',
  'M16 12h.01',
  'M18 8h.01',
  'M6 8h.01',
  'M7 16h10',
  'M8 12h.01'
]

const KEY_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0.3, 1],
    transition: { type: 'tween' as const, duration: 0.45, ease: ICON_EASE, delay: i * 0.06 }
  })
}

export function KeyboardIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="16" rx="2" width="20" x="2" y="4" />
      {KEYS.map((d, i) => (
        <motion.path key={d} variants={KEY_VARIANTS} custom={i} d={d} />
      ))}
    </IconShell>
  )
}
