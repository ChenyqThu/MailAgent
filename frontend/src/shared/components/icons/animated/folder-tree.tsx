// lucide-animated · folder-tree（主干先画，子节点依次浮现）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_DRAW, folderTween } from '../folderMotion'

const BRANCH_IN: Variants = {
  normal: { opacity: 1, x: 0 },
  animate: (custom: number = 0) => ({
    opacity: [0, 1],
    x: [-2, 0],
    transition: folderTween(0.35, 0.12 + custom * 0.1)
  })
}

export function FolderTreeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={FOLDER_DRAW} d="M3 3v13a2 2 0 0 0 2 2h3" />
      <motion.path variants={FOLDER_DRAW} d="M3 5a2 2 0 0 0 2 2h3" />
      <motion.path
        variants={BRANCH_IN}
        custom={0}
        d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
      />
      <motion.path
        variants={BRANCH_IN}
        custom={1}
        d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
      />
    </IconShell>
  )
}
