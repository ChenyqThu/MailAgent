// assistant-modal P1 — 正文右下角 FAB 浮窗入口（取代邮件工具栏的 AI 按钮）。点击展开 modal（FAB 随
// visible 隐藏）。仅在「有激活对象（邮件 / 事项，且其详情正在显示）+ modal 未展开(!visible)」时
// 显示，避免与 modal 重叠。createPortal 到 document.body 逃 InboxLayout 的 overflow-hidden + GSAP
// width tween（同 BatchActionBar 范式）。InboxLayout / MattersLayout 各挂一份（S3: ASSISTANT_MODAL
// flag 已 GA 移除）。
//
// 09-02 —— 对象标签 ↔ dock 会话绑定：点击时按激活标签的 `chatSessionId` 递请求（绑了回它的会话，
// 没绑开新会话，首发后由 AssistantChatModal 写回）；事项标签顺带 seed 事项 chip（对称于邮件从
// activeInternalId seed），事项页不再有头部按钮与专属欢迎语。
//
// 视觉（0813）：钮面 = **主 agent 头像**（`ChatFabAvatar`，自带 level-1 外投影）。
// hover = **头像放大 + tips**，两件都不换表情（0813 dogfood owner 原话：「hover 不要改表情啊，
// 只是头像放大+tips」）：
//   · 放大 —— `ChatFabAvatar` 内的 `group-hover:scale-110`，靠本按钮的 `group` 驱动；
//   · tips —— 复用仓内既有的 `HoverTip`（chip 材质/字号/投影全走它，本文件不自搭浮层）。
//     它取代了原先手搓的「max-width 展开 pill + ⌘J kbd 角标」：快捷键并进 tip 文案，
//     沿用同区 `historyHint`/`closePanel` 那条「动作 · 快捷键」的既有 i18n 写法。

import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { ChatFabAvatar } from '@shared/assistant/modal/ChatFabAvatar'
import { openDockForTab } from '@shared/assistant/modal/dockForTab'
import { useMatterWorkspace } from '@shared/components/matters/matterWorkspaceStore'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import {
  selectDockAnchorTab,
  useTabWorkspace,
  type TabDescriptor
} from '@shared/state/tab-workspace'

/** FAB 的锚对象：激活的邮件 / 事项标签，且它的详情正在显示 —— 窄屏「返回」/ 选中项掉出可见集
 *  这两种视图局部的取消选中会把投影清成 null，那时没有正文可聊，FAB 跟着藏。
 *  InboxLayout / MattersLayout 共用这一份判据。 */
function useDockAnchorTab(): TabDescriptor | null {
  const tab = useTabWorkspace(selectDockAnchorTab)
  const activeEmailId = useActiveEmail((s) => s.activeInternalId)
  const selectedMatterId = useMatterWorkspace((s) => s.selectedId)
  if (tab === null) return null
  const shown = tab.kind === 'email' ? activeEmailId !== null : selectedMatterId !== null
  return shown ? tab : null
}

export function ChatModalFab(): React.JSX.Element | null {
  const { t } = useTranslation()
  const visible = useAIChatPanel((s) => s.visible)
  const anchorTab = useDockAnchorTab()
  // 仅在有激活对象 + modal 未展开（最小化态）时显示。
  if (visible || anchorTab === null) return null
  return createPortal(
    <button
      type="button"
      onClick={() => openDockForTab(anchorTab)}
      aria-label={t('chat.fab.label')}
      className="group fixed bottom-8 right-5 z-40 flex items-center animate-in fade-in zoom-in-95 duration-300 ease-out motion-reduce:animate-none motion-reduce:transition-none"
    >
      {/* tip 朝左展开（钮贴着右边缘），方向与被它取代的那条 pill 一致。 */}
      <HoverTip text={t('chat.fab.hint')} side="left">
        <ChatFabAvatar />
      </HoverTip>
    </button>,
    document.body
  )
}
