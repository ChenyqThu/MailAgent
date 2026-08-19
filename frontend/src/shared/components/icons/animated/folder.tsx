// lucide-animated · folder（盖沿轻抬再落回）—— 没设过图标 / 存的 key 不认识时的兜底。
// 几何取自 lucide-react@1.16.0 __iconNode；动效按 §10 显式 tween + ICON_EASE。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, folderTween } from '../folderMotion'

const LID: Variants = {
  normal: { y: 0 },
  animate: { y: [0, -1.2, 0], transition: { ...folderTween(0.45), times: [0, 0.4, 1] } }
}

export function FolderIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={LID} d={FOLDER_BODY_FULL} />
    </IconShell>
  )
}
