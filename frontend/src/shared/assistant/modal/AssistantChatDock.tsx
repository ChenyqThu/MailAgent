// AssistantChatDock — 「哪个路由能有 AI dock」的唯一宿主。
//
// 0812 dogfood 的 P0：事项详情的「事项对话」按钮只写 zustand（openMatterChat），而唯一消费
// `matterTarget` 的 AssistantChatModal 当时**只挂在 InboxLayout（`/`）**上 —— `/matters` 走
// MattersLayout，组件树里根本没有这个消费者，于是状态写下去那一屏没人读 = 点了没反应。
//
// 🔴 为什么不提到 RootLayout 做全局单例：dock 的 sidebar 模式是**行内 flex 子节点**（靠布局
// 位置吃宽度、挤压正文，见 AssistantChatModal 的 wrapperClass 三分支）。RootLayout 里它只能
// 是整个页面 shell 的兄弟，sidebar 模式的挤压布局当场失效。所以按「每个需要 dock 的 layout
// 各挂一份宿主」办，宿主本身收在这里，避免两处复制那套 lazy + mount-once 门。
//
// mount-once：首次展开前不下载 chunk、不建会话（AssistantChatModal 内部另有一层 latch，两层
// 语义一致：一旦挂上就不再卸载，最小化只是 CSS 隐藏，会话/在途流不受影响）。

import { lazy, Suspense, useEffect, useState } from 'react'

import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

const AssistantChatModal = lazy(() =>
  import('@shared/assistant/modal/AssistantChatModal').then((module) => ({
    default: module.AssistantChatModal
  }))
)

export function AssistantChatDock(): React.JSX.Element | null {
  const chatVisible = useAIChatPanel((s) => s.visible)
  const [mountChat, setMountChat] = useState(chatVisible)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (chatVisible) setMountChat(true)
  }, [chatVisible])
  if (!mountChat) return null
  return (
    <Suspense
      fallback={
        chatVisible ? <Skeleton rows={6} className="h-full w-96 shrink-0 p-6" width="2/3" /> : null
      }
    >
      <AssistantChatModal />
    </Suspense>
  )
}
