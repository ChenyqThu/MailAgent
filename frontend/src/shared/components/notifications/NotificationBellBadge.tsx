// TitleBar 统一通知铃铛（task 08-20-notification-center 步骤 7；design §6.1）。
//
// 与 SystemAlertBadge / AgentPendingBadge 的关键差别：**恒渲染**。通知中心没有 flag
// （owner 2026-08-20 拍板不做灰度，design §8.e），铃铛是常驻入口 —— 未读为 0 时退化成一枚
// 素图标按钮（与旁边的快捷键帮助按钮同款），未读 > 0 才升级成 accent 计数徽标（配方照
// SystemAlertBadge：bg/15 + border/40 + 12px mono tabular-nums）。计数**加载完成前不显示
// 计数点**（请求失败同理）：不闪一个假的 0，也不因为通知面挂了就让 chrome 少一个按钮。
//
// popover 用 createPortal 送到 <body>：TitleBar 有 backdrop-filter，会给 fixed 子元素造一个
// 层叠上下文，浮层留在里面会被裁（AccentPickerPopover / SystemAlertBadge 同款理由）。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

import { NotificationPanel } from './NotificationPanel'
import { useNotificationUnreadCount } from './hooks'

/** 徽标计数上限（design §6.1）。 */
const COUNT_CAP = 99

export function NotificationBellBadge(): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })

  const unreadQuery = useNotificationUnreadCount()
  // 未加载 / 请求失败 → null（不是 0）：下面据此不渲染计数点。
  const unread = unreadQuery.data?.total ?? null
  const hasUnread = unread != null && unread > 0

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = hasUnread
    ? t('notifications.tooltip', { count: unread })
    : t('notifications.tooltipEmpty')

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-live="polite"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'group flex items-center transition-colors duration-fast',
          hasUnread
            ? // 徽标态: SystemAlertBadge 配方 (rounded-md / bg·border /15·/40 / 12px mono)
              'gap-1.5 px-2 py-0.5 rounded-md border border-coral/40 bg-coral/15 text-coral text-meta font-mono hover:bg-coral/25'
            : // 素图标态: 与右侧相邻的快捷键帮助按钮同款 (rounded / p-1.5 / ink-fg-2)
              'justify-center p-1.5 rounded text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4'
        )}
      >
        {hasUnread ? (
          <>
            <Bell size={12} strokeWidth={2.25} />
            <span className="tabular-nums">{unread > COUNT_CAP ? `${COUNT_CAP}+` : unread}</span>
          </>
        ) : (
          <Bell size={13} strokeWidth={2} />
        )}
      </button>

      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('notifications.title')}
            className="theme-popover glass-pop flex flex-col"
            style={{ width: 380, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <NotificationPanel onClose={() => setOpen(false)} />
          </div>,
          document.body
        )}
    </>
  )
}
