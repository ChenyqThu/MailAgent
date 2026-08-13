// 输入防抖。⌘K palette 的本地实现（`CommandPalette.tsx`，250ms）下沉到这里 —— 批次 2a
// review 的 LOW-2 要给「关联资料」弹窗的邮件搜索加同款防抖，与其抄第二份不如共用一份。
// 零依赖叶子模块：只用 react，任何面都能 import 而不会被顺带拉进无关的东西。

import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return (): void => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}
