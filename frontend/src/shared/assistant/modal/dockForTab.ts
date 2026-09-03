// 09-02 —— 「按对象标签唤出 dock」的单一解析：FAB 点击与「dock 开着切标签」（AssistantChatModal）
// 共用。事项标签 → 带这件事的 chip 唤出（openMatterChat，与「立即跟进」同一 seed）；邮件标签 →
// 通用唤出（邮件 chip 由 AgentConversation 从 activeInternalId seed）。随后按标签的 `chatSessionId`
// 绑定递一条一次性会话请求，由 AssistantChatModal 消费：绑了回它的会话，没绑开新会话，首发后写回。
//
// 独立成非组件模块：ChatModalFab.tsx 是组件文件，多导出一个函数会破 react-refresh 的
// only-export-components。

import { matterPublicIdOf } from '@shared/components/matters/matterTabIdentity'
import { openChatModal, openMatterChat, useAIChatPanel } from '@shared/state/ai-chat-panel'
import type { TabDescriptor } from '@shared/state/tab-workspace'

export function openDockForTab(tab: TabDescriptor): void {
  const publicId = tab.kind === 'matter' ? matterPublicIdOf(tab.targetId) : null
  if (publicId !== null) {
    openMatterChat({ id: tab.targetId, publicId, title: tab.title })
  } else {
    openChatModal()
  }
  useAIChatPanel.getState().requestTabSession(tab.chatSessionId ?? null)
}
