// lucide-animated · folder-kanban（三列依次长高）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_ROUND, folderOrigin, folderTween } from '../folderMotion'

const COLUMN: Variants = {
  normal: { scaleY: 1 },
  animate: (custom: number = 0) => ({
    scaleY: [0.25, 1],
    transition: folderTween(0.35, custom * 0.09)
  })
}

export function FolderKanbanIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_ROUND} />
      {/* 每列的基准点钉在自己的底端，才是「长高」不是「整根平移」。 */}
      <motion.path variants={COLUMN} custom={0} style={folderOrigin(8, 14)} d="M8 10v4" />
      <motion.path variants={COLUMN} custom={1} style={folderOrigin(12, 12)} d="M12 10v2" />
      <motion.path variants={COLUMN} custom={2} style={folderOrigin(16, 16)} d="M16 10v6" />
    </IconShell>
  )
}
