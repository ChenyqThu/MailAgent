// 「添加文件夹」这条流程的编排（design §8.2）：弹系统目录对话框 → 拿到绝对路径 → 交给
// `AddMountDialog` 做确认面板。二级栏树底部与设置页挂载区两个入口共用它。
//
// 与组件分文件的唯一原因是 lint 的 `react-refresh/only-export-components`：一个文件不能既导出
// 组件又导出别的东西。

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AddMountDialog } from './AddMountDialog'
import { usePickMountFolder } from './mountHooks'

export interface AddMountFlow {
  /** 弹系统目录对话框；用户取消 = 什么都不发生。 */
  begin(): Promise<void>
  /** 摊在调用方的 JSX 里；没在流程中时是 `null`。 */
  dialog: ReactNode
}

export function useAddMountFlow(): AddMountFlow {
  const { t } = useTranslation()
  const pick = usePickMountFolder()
  const [picked, setPicked] = useState<string | null>(null)

  const begin = useCallback(async (): Promise<void> => {
    const absPath = await pick(t('library.mount.add'))
    if (absPath !== null && absPath !== '') setPicked(absPath)
  }, [pick, t])

  return useMemo(
    () => ({
      begin,
      dialog:
        picked === null ? null : (
          <AddMountDialog
            absPath={picked}
            onClose={() => setPicked(null)}
            onAdded={() => setPicked(null)}
          />
        )
    }),
    [begin, picked]
  )
}
