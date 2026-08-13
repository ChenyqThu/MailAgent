// assistant-modal P1 — 正文右下角 FAB 浮窗入口（取代邮件工具栏的 AI 按钮）。hover 向左展开
// "chat about this page" 文案 + ⌘J 角标；点击 openChatModal() 展开 modal（FAB 随 visible 隐藏）。
// 仅在「有邮件正文(activeInternalId) + modal 未展开(!visible)」时显示，避免与 modal 重叠。createPortal
// 到 document.body 逃 InboxLayout 的 overflow-hidden + GSAP width tween（同 BatchActionBar 范式）。
// InboxLayout 无条件挂载（S3: ASSISTANT_MODAL flag 已 GA 移除）。
//
// 视觉（0813 换代）：钮面 = **主 agent 头像** + 沿其真实轮廓旋转的光环（`ChatFabAvatar`）。
// 取代了原先的 accent 实心圆钮 + sparkles 图标 + reactbits StarBorder conic 环 —— 那套环是
// 「conic 圆盘 + 圆形内盖露 2px 边」，结构上绑死圆形，异形头像下没法保留（`.rb-star-border`
// 与 `rb-star-spin` 已随之从 index.css 删除，全仓无第二处消费点）。位置 bottom-8 避开 footer。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { cn } from '@shared/lib/cn'
import { ChatFabAvatar } from '@shared/assistant/modal/ChatFabAvatar'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel, openChatModal } from '@shared/state/ai-chat-panel'

export function ChatModalFab(): React.JSX.Element | null {
  const { t } = useTranslation()
  const visible = useAIChatPanel((s) => s.visible)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const [hovered, setHovered] = useState(false)
  // 仅在有邮件正文 + modal 未展开（最小化态）时显示。
  if (visible || activeId == null) return null
  return createPortal(
    <button
      type="button"
      onClick={openChatModal}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      aria-label={t('chat.fab.label')}
      className="group fixed bottom-8 right-5 z-40 flex items-center animate-in fade-in zoom-in-95 duration-300 ease-out motion-reduce:animate-none motion-reduce:transition-none"
    >
      {/* hover 向左展开的文案 pill + ⌘J 角标（max-width 过渡；reduced-motion 立即切换） */}
      <span
        className={cn(
          'mr-2 flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full',
          'text-meta text-ink-fg-1 opacity-0 transition-[max-width,padding,opacity,box-shadow,background-color] duration-base ease-standard',
          'group-hover:max-w-[16rem] group-hover:bg-ink-2 group-hover:px-3 group-hover:py-1.5',
          'group-hover:opacity-100 group-hover:shadow-md motion-reduce:transition-none'
        )}
      >
        {t('chat.fab.label')}
        <kbd className="rounded border border-[var(--hairline)] bg-ink-3 px-1 font-mono text-micro text-ink-fg-2">
          ⌘J
        </kbd>
      </span>
      {/* 钮面：主 agent 头像 + 轮廓光环（同源 / 性能 / 上传图回落全在 ChatFabAvatar 内说明）。 */}
      <ChatFabAvatar hovered={hovered} />
    </button>,
    document.body
  )
}
