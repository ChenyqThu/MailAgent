// lucide-animated · folder-open（前盖沿轮廓扫开）。几何取自 lucide-react@1.16.0 __iconNode。
//
// lucide 的 folder-open 是**一整条** path，盖子拆不出来。硬套一个整体 rotate/scale
// 就成了「统一糊一个 transform」—— 这里改成沿轮廓描线：前盖那一段最后画出来，
// 读起来就是盖子扫开。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderTween } from '../folderMotion'

const SWEEP: Variants = {
  normal: { pathLength: 1 },
  animate: { pathLength: [0.45, 1], transition: folderTween(0.5) }
}

export function FolderOpenIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={SWEEP}
        d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
      />
    </IconShell>
  )
}
