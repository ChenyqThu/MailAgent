// lucide-animated · folder-x（两笔交叉错开划掉）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, FOLDER_DRAW } from '../folderMotion'

export function FolderXIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_FULL} />
      <motion.path variants={FOLDER_DRAW} custom={0} d="m9.5 10.5 5 5" />
      <motion.path variants={FOLDER_DRAW} custom={1} d="m14.5 10.5-5 5" />
    </IconShell>
  )
}
