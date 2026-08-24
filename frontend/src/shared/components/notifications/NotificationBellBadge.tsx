// TitleBar 统一通知铃铛（task 08-20-notification-center 步骤 7；design §6.1）。
//
// **恒渲染**。通知中心没有 flag（owner 2026-08-20 拍板不做灰度，design §8.e），铃铛是常驻
// 入口 —— 未读为 0 时退化成一枚素图标按钮（与旁边的快捷键帮助按钮同款），未读 > 0 才升级成
// accent 计数徽标（bg/15 + border/40 + 12px mono tabular-nums）。计数**加载完成前不显示计数
// 点**（请求失败同理）：不闪一个假的 0，也不因为通知面挂了就让 chrome 少一个按钮。
//
// M2 加了**红点档**：未读里有 critical（`bySeverity.critical > 0`）时整枚徽标换成 fail 配方
// + 图标上一颗 pulse 红点 ——「红 = 有严重的事」。
//
// M3 批 C5 收编了 TitleBar 的另外两枚徽标（SystemAlertBadge / AgentPendingBadge），随之补了
// 第三档 **待办点**：`openByCategory.action_required > 0` 且未读为 0 时，素图标上挂一颗**静态**
// warn 圆点。理由是被收编的审批徽标是 **level 型**（挂着就在），而未读数是 **edge 型**（看过
// 一眼就掉）—— 只留未读的话「读了通知但没去批」会让 chrome 上什么都不剩。pulse 红点仍专属
// critical：两档在同一枚图标上必须一眼分得开。
//
// popover 用 createPortal 送到 <body>：TitleBar 有 backdrop-filter，会给 fixed 子元素造一个
// 层叠上下文，浮层留在里面会被裁（AccentPickerPopover 同款理由）。横向落点走
// `useAnchoredPopover`（`.theme-popover` 写死的 right:12px 只对簇内最右的按钮成立，铃铛在
// 簇首会整整偏出一个面板宽）。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useAnchoredPopover } from '@shared/hooks/useAnchoredPopover'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

import { NotificationPanel } from './NotificationPanel'
import { useNotificationUnreadCount } from './hooks'
import { bellBadgeState } from './notificationModel'

/** 徽标计数上限（design §6.1）。 */
const COUNT_CAP = 99

/** tooltip / aria 文案。未读（edge）与待办（level）是两件事，都在场时一句话里都要报数
 *  —— 只报未读会让「读过但没批」的待办在无障碍层面也消失。 */
function bellLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  unread: number,
  pending: number
): string {
  if (unread > 0 && pending > 0) {
    return t('notifications.tooltipBoth', { count: unread, pending })
  }
  if (unread > 0) return t('notifications.tooltip', { count: unread })
  if (pending > 0) return t('notifications.tooltipPending', { count: pending })
  return t('notifications.tooltipEmpty')
}

export function NotificationBellBadge(): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // 出入场档比旁边几个 picker 重一档：这块面板 380×~520，picker 的 264px 小卡那套
  // （y:-6 / DUR.fast）套上来等于没动效。转轴仍是右上角 —— 面板右缘对齐铃铛，展开方向
  // 与视觉来源一致。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -8, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.base
  })
  const placement = useAnchoredPopover(triggerRef, scopeRef, shouldRender)

  const unreadQuery = useNotificationUnreadCount()
  // 未加载 / 请求失败 → unread 为 null（不是 0）：下面据此不渲染计数点。
  const { unread, critical, pendingActionCount } = bellBadgeState(unreadQuery.data)
  const hasUnread = unread != null && unread > 0
  // 待办点只在计数徽标缺席时出场：未读 > 0 时 chrome 上已经有可见的东西了，两个一起挂
  // 反而分不清「几条未读」和「几项待办」。
  const showPendingDot = !hasUnread && pendingActionCount > 0

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      // 🔴 行菜单（Popmenu portal 档）挂在 <body> 上、不在面板 DOM 里：上面两道判定会把
      // 「点 Snooze」当成点在面板外 → 整个面板先关掉、菜单的 onSelect 再也跑不到。按基座
      // 自己的标记放行（`data-popmenu-portal` 由 Popmenu 在 portal 档写在栈根上）。
      if (target instanceof Element && target.closest('[data-popmenu-portal]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 行菜单开着时 Esc 归它（Popmenu 自己也挂 document 监听）。两个监听在**同一个节点**
      // 上，Popmenu 的 stopPropagation 拦不住兄弟监听 —— 不判一下就会「一次 Esc 连面板
      // 一起关」。菜单退场动画期间标记还在，最坏是多按一次 Esc。
      if (document.querySelector('[data-popmenu-portal]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = bellLabel(t, unread ?? 0, pendingActionCount)

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
            ? // 徽标态: rounded-md / bg·border /15·/40 / 12px mono。
              // critical 未读 → fail 档，否则 accent 计数点。
              cn(
                'gap-1.5 px-2 py-0.5 rounded-md border text-meta font-mono',
                critical
                  ? 'border-fail/40 bg-fail/15 text-fail hover:bg-fail/25'
                  : 'border-coral/40 bg-coral/15 text-coral hover:bg-coral/25'
              )
            : // 素图标态: 与右侧相邻的快捷键帮助按钮同款 (rounded / p-1.5 / ink-fg-2)
              'justify-center p-1.5 rounded text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4'
        )}
      >
        {hasUnread ? (
          <>
            <span className="relative inline-flex">
              <Bell size={12} strokeWidth={2.25} />
              {/* pulse 红点只在 critical 档。 */}
              {critical && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5">
                  <span className="absolute inset-0 rounded-full bg-fail opacity-75 animate-ping" />
                  <span className="absolute inset-0 rounded-full bg-fail" />
                </span>
              )}
            </span>
            <span className="tabular-nums">{unread > COUNT_CAP ? `${COUNT_CAP}+` : unread}</span>
          </>
        ) : (
          <span className="relative inline-flex">
            <Bell size={13} strokeWidth={2} />
            {/* 待办点：**静态**（不 ping）—— pulse 是 critical 的专属信号；几何沿用上面
                critical 红点的角标位与尺寸，只换 token。 */}
            {showPendingDot && (
              <span
                className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warn"
                data-testid="notification-pending-dot"
                aria-hidden
              />
            )}
          </span>
        )}
      </button>

      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('notifications.title')}
            className="theme-popover glass-pop flex flex-col"
            style={
              {
                width: 380,
                // 短窗口下面板不撞视口底：根收口后，面板里唯一的滚动区（列表）自己降档
                // （它是 overflow-y-auto 的 flex 子项，min-height 解析为 0 会跟着缩）。
                ...(placement ? { right: placement.right, maxHeight: placement.maxHeight } : {}),
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            <NotificationPanel onClose={() => setOpen(false)} />
          </div>,
          document.body
        )}
    </>
  )
}
