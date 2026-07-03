// assistant-modal P1 — 正文右下角圆形 FAB 浮窗入口（取代邮件工具栏的 AI 按钮）。hover 向左展开
// "chat about this page" 文案 + ⌘J 角标；点击 openChatModal() 展开 modal（FAB 随 visible 隐藏）。
// 仅在「有邮件正文(activeInternalId) + modal 未展开(!visible)」时显示，避免与 modal 重叠。createPortal
// 到 document.body 逃 InboxLayout 的 overflow-hidden + GSAP width tween（同 BatchActionBar 范式）。
// InboxLayout 无条件挂载（S3: ASSISTANT_MODAL flag 已 GA 移除）。
//
// 视觉（dogfood 反馈）：reactbits StarBorder 常驻彩色旋转边框环（.rb-star-border，三色 conic 旋转
// + 外发光）+ sparkles 动态图标（整钮 hover 经 AnimatedIconActiveProvider 驱动）；位置 bottom-8 避开 footer。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { cn } from '@shared/lib/cn'
import { AnimatedIconActiveProvider, SparklesIcon } from '@shared/components/icons'
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
          'text-meta text-ink-fg-1 opacity-0 transition-all duration-base ease-standard',
          'group-hover:max-w-[16rem] group-hover:bg-ink-2 group-hover:px-3 group-hover:py-1.5',
          'group-hover:opacity-100 group-hover:shadow-md motion-reduce:transition-none'
        )}
      >
        {t('chat.fab.label')}
        <kbd className="rounded border border-[var(--hairline)] bg-ink-3 px-1 font-mono text-micro text-ink-fg-2">
          ⌘J
        </kbd>
      </span>
      {/* 圆钮：StarBorder 常驻彩色旋转边框环（.rb-star-border ::before 三色 conic 旋转 + ::after 外
          发光）+ 内圈 accent 实心（inset 2px 盖中心、露边缘彩色环）+ sparkles 动态图标（z 在环之上）。 */}
      <span
        className={cn(
          'rb-star-border relative grid size-12 shrink-0 place-items-center rounded-full shadow-md',
          'transition-transform duration-fast group-hover:scale-105 motion-reduce:transition-none'
        )}
      >
        <span
          className="absolute inset-[2px] rounded-full bg-[rgb(var(--c-accent))]"
          aria-hidden="true"
        />
        <AnimatedIconActiveProvider active={hovered}>
          <SparklesIcon
            size={20}
            strokeWidth={2}
            className="relative z-[1] text-[rgb(var(--c-accent-fg))]"
          />
        </AnimatedIconActiveProvider>
      </span>
    </button>,
    document.body
  )
}
