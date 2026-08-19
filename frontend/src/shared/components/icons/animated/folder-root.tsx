// lucide-animated · folder-root（节点亮起，根须向下长）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_ROUND, FOLDER_DRAW, FOLDER_PULSE, folderOrigin } from '../folderMotion'

export function FolderRootIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_ROUND} />
      <motion.circle
        variants={FOLDER_PULSE}
        custom={1.25}
        style={folderOrigin(12, 13)}
        cx="12"
        cy="13"
        r="2"
      />
      <motion.path variants={FOLDER_DRAW} custom={1} d="M12 15v5" />
    </IconShell>
  )
}
