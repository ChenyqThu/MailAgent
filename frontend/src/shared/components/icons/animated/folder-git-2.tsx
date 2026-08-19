// lucide-animated · folder-git-2（分支画出，末端节点后弹）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_DRAW, FOLDER_PULSE, folderOrigin } from '../folderMotion'

export function FolderGit2Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
      <circle cx="13" cy="12" r="2" />
      <motion.path variants={FOLDER_DRAW} d="M18 19a5 5 0 0 1-5-5v8" />
      <motion.circle
        variants={FOLDER_PULSE}
        custom={1.35}
        style={folderOrigin(20, 19)}
        cx="20"
        cy="19"
        r="2"
      />
    </IconShell>
  )
}
