// lucide-animated · folder-minus（横杠描线）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, FOLDER_DRAW } from '../folderMotion'

export function FolderMinusIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_FULL} />
      <motion.path variants={FOLDER_DRAW} d="M9 13h6" />
    </IconShell>
  )
}
