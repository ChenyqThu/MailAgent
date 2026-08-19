// lucide-animated · folder-git（节点亮起，两侧连线外画）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, FOLDER_DRAW, FOLDER_PULSE, folderOrigin } from '../folderMotion'

export function FolderGitIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_FULL} />
      <motion.circle
        variants={FOLDER_PULSE}
        custom={1.3}
        style={folderOrigin(12, 13)}
        cx="12"
        cy="13"
        r="2"
      />
      <motion.path variants={FOLDER_DRAW} custom={1} d="M14 13h3" />
      <motion.path variants={FOLDER_DRAW} custom={1} d="M7 13h3" />
    </IconShell>
  )
}
