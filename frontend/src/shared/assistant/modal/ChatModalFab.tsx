// assistant-modal P1 — 正文右下角 FAB 浮窗入口（取代邮件工具栏的 AI 按钮）。点击 openChatModal()
// 展开 modal（FAB 随 visible 隐藏）。仅在「有邮件正文(activeInternalId) + modal 未展开(!visible)」时
// 显示，避免与 modal 重叠。createPortal 到 document.body 逃 InboxLayout 的 overflow-hidden + GSAP
// width tween（同 BatchActionBar 范式）。InboxLayout 无条件挂载（S3: ASSISTANT_MODAL flag 已 GA 移除）。
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
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel, openChatModal } from '@shared/state/ai-chat-panel'

export function ChatModalFab(): React.JSX.Element | null {
  const { t } = useTranslation()
  const visible = useAIChatPanel((s) => s.visible)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  // 仅在有邮件正文 + modal 未展开（最小化态）时显示。
  if (visible || activeId == null) return null
  return createPortal(
    <button
      type="button"
      onClick={openChatModal}
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
