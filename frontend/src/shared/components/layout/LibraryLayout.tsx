// /library route shell — 资料库域（design §2.1）。二级栏 = LibraryWorkspace 自管的文件夹树列
// （registry 里 library 域是 second:'page'），三栏布局与 rightDock 都在工作区里，故本壳只做
// 懒加载分片。
//
// 🔴 这里**不再**包一层 `PageFrame`：LibraryWorkspace 自己就是 `PageFrame` +
// `rightDock={<AssistantChatDock/>}`（见该文件的 return），外面再套一层会出两个 dock 宿主。

import { lazy, Suspense } from 'react'

// Lazy：工作区拖着文件树 / 六个预览子面 / 历史抽屉整条链（含 Streamdown），让它走自己的
// chunk（同 SessionsLayout 对 AgentViewLayout 的做法）。
const LibraryWorkspace = lazy(() =>
  import('../library/LibraryWorkspace').then((m) => ({ default: m.LibraryWorkspace }))
)

export function LibraryLayout(): React.ReactElement {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <LibraryWorkspace />
    </Suspense>
  )
}
