// lucide-animated · folders（前层错开滑出，后层退让）。源 pqoqubbw/icons，改造：
// spring（stiffness/damping）→ 显式 tween + ICON_EASE（§10 禁 spring）；去 forwardRef/div 外壳。
//
// 🔴 几何刷新（folder 图标批，2026-08-19）：旧版是 lucide 早期的
// `M20 17a2 2 0 0 0 2-2V9…` + `M2 8v11a2 2 0 0 0 2 2h14`，与本仓 lucide-react@1.16.0
// 的 __iconNode 已经对不上（新版前层是右上角那张、后层只画左下轮廓）。这里换成 1.16.0
// 的两条 d 串（`node_modules/lucide-react/dist/esm/icons/folders.mjs` 直接读的）。
// 顺带把后层的退让从「整个消失」（opacity→0 + scale 0.9）改成 `opacity→0.35` ——
// 两张纸叠着错开时后面那张仍在，才读得出层次；整张消失读成的是「删掉一层」。
//
// ⚠️ 本图标同时是侧边栏「所有邮件」行的图标（icons/mailboxIcons.ts，经 nav
// registry 的 entry 工厂引用），刷新会同步改到那一行的观感。这是有意的：内建行
// 与文件夹选择器里的候选图标同版。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderTween } from '../folderMotion'

const FRONT: Variants = {
  normal: { x: 0, y: 0 },
  animate: { x: -2, y: 2, transition: folderTween(0.4) }
}
const BACK: Variants = {
  normal: { x: 0, y: 0, opacity: 1 },
  animate: { x: 2, y: -2, opacity: 0.35, transition: folderTween(0.4) }
}

export function FoldersIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={FRONT}
        d="M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"
      />
      <motion.path
        variants={BACK}
        d="M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"
      />
    </IconShell>
  )
}
