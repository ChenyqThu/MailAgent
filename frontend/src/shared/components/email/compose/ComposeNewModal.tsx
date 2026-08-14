// 写新邮件 (compose new) 可拖动浮窗外壳 (epic T5, 契约 D4 / design/app.jsx FloatingShell)。
//
// 写新邮件是「全局动作」(不属于任何已打开邮件)，脱离三栏布局: scrim + 居中 glass-pop
// 浮窗, portal 到 document.body 避开父级 overflow 裁剪。浮窗标题栏可拖动 (translate)、
// 双击/按钮 最大化⇄还原、× 关闭。卡片内复用 ComposePanelInner (mode='new' +
// variant='modal') —— 表单 UI 与 reply/forward/draft-edit 完全一致。
//
// 进退场动效 (frontend §8 / motion-gsap §4)：useExitAnimation 把卸载推迟到退场动画
// 播完。拖拽位移落在独立 wrapper 层 (不是 data-anim-card) —— GSAP 进场结束会
// clearProps transform, 与拖拽 translate 同层会互相覆盖。
//
// 关闭路径全部收敛到 store 的 close (T6 dirty 守卫的统一挂钩点): 点 scrim / 标题栏 × /
// ESC (ComposePanelInner window keydown → onClose) / 发送成功 / 放弃。挂载在
// RootLayout (router-instance.tsx) 全局一次，任意路由都能由侧边栏按钮或 ⌘N 打开。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, PenLine, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useComposeNewStore } from '@shared/state/compose-new'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

import { ComposePanelInner } from './ComposePanel'
import type { ComposeGuardHandle } from './useComposeGuard'

/** 写新邮件用的哨兵 internalId — 无对应 email_metadata 行。draft.ts / serve-api
 *  adapter 与 service _prepare_draft 对 mode='new' 放宽 record 强制 (sync_store.get(-1)
 *  =None → {}), 走 explicit_body 分支零线程派生。ComposePanelInner 所有 query 的
 *  `internalId >= 0` 守卫天然 false。 */
const NEW_COMPOSE_SENTINEL = -1

export function ComposeNewModal(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useComposeNewStore((s) => s.open)
  const close = useComposeNewStore((s) => s.close)
  // 通讯录「写邮件」等入口的预填收件人 / 抄送（打开那一刻的快照；store 关闭即清）。
  const prefillTo = useComposeNewStore((s) => s.prefillTo)
  const prefillCc = useComposeNewStore((s) => s.prefillCc)
  // T6 离开守卫: scrim / 标题栏 × 关闭前先问 ComposePanelInner (经 guardRef) 有没有
  // 未保存更改 —— 有则弹确认 (保存草稿/丢弃/取消), 无则直接关。ComposePanelInner 内部
  // ESC/丢弃走 onClose=close (自身已守卫), 不经此 ref, 故两侧不会双重弹窗。
  const guardRef = useRef<ComposeGuardHandle | null>(null)
  const guardedClose = useCallback(() => {
    const g = guardRef.current
    if (g) g.attemptClose(close)
    else close()
  }, [close])
  // 最大化 / 拖拽位移 — 浮窗形态状态。关闭卸载后 store 重开会重挂 (状态自然复位)。
  const [maximized, setMaximized] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  // codex F9 — 在途拖拽的 window 监听清理句柄: mousedown 后组件卸载 (发送成功关闭 /
  // 退场动画结束) mousemove 不能存活继续 setPos; 最大化切换也终止在途拖拽。
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])
  const toggleMaximized = useCallback(() => {
    endDragRef.current?.()
    setMaximized((v) => !v)
  }, [])
  // 进退场动效 (root=scrim + 卡片 data-anim-card)。shouldRender 在退场动画播完前
  // 保持 true, 卡片卸载推迟到动画结束。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })
  // focus-trap: Tab 在卡片内循环, 焦点逃出时下次 Tab snap 回; root (scrim,
  // tabIndex=-1) 作 fallback 焦点目标。初始 focus 若已被面板内 autoFocus (To 字段)
  // 占住则不抢 (useFocusTrap 的 contains(activeElement) 守卫)。ESC 关闭由
  // ComposePanelInner 的 window keydown handler 接管 (此处 onKeyDown 只管 Tab)。
  // ignoreOutsideTargets (codex F3): 面板内的 Radix 子弹窗 (UnsavedChanges/
  // SendConfirm/DeleteDraft) portal 到 body, 其 Tab 经 React 树冒泡到浮窗 —— 不
  // 接管, 否则 snap-back 会把子弹窗焦点拖回背景 composer (双焦点陷阱互抢)。
  const { dialogRef, handleTab } = useFocusTrap({
    open,
    fallbackRef: scopeRef,
    ignoreOutsideTargets: true
  })

  // 标题栏拖动 (design/app.jsx FloatingShell.onHeaderDown): mousedown 记起点,
  // window mousemove 更新 translate, mouseup 摘监听。最大化时不可拖。
  const onHeaderMouseDown = (e: React.MouseEvent): void => {
    if (maximized) return
    // 标题栏里的按钮 (最大化/关闭) 不触发拖动。
    if ((e.target as HTMLElement).closest('button')) return
    endDragRef.current?.() // 防重: 上一段在途拖拽先终止 (F9)
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y }
    const move = (ev: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      setPos({ x: d.px + (ev.clientX - d.sx), y: d.py + (ev.clientY - d.sy) })
    }
    const end = (): void => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      endDragRef.current = null
    }
    endDragRef.current = end
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
  }

  if (!shouldRender) return null

  return createPortal(
    <div
      ref={scopeRef}
      tabIndex={-1}
      onClick={guardedClose}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 py-[6vh] bg-black/40 focus:outline-none"
    >
      {/* 拖拽位移层 — 独立于 GSAP 动画目标 (data-anim-card), 见文件头注释。 */}
      <div
        className="max-w-full"
        style={maximized ? undefined : { transform: `translate(${pos.x}px, ${pos.y}px)` }}
      >
        {/* 浮窗 — 真浮层材质 glass-pop + --r-pop (浮层铁律)。onClick stopPropagation
            防点卡片冒泡到 scrim 误关。固定高度让正文 editor (flex-1) 有确定空间撑满。 */}
        <div
          ref={dialogRef}
          data-anim-card
          role="dialog"
          aria-modal="true"
          aria-label={t('nav.composeNew')}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => handleTab(e)}
          className={cn(
            'relative flex flex-col rounded-[var(--r-pop)] glass-pop overflow-hidden',
            maximized ? 'w-[94vw] h-[88vh]' : 'w-[740px] max-w-[92vw] h-[min(760px,84vh)]'
          )}
        >
          {/* 标题栏 — 拖动手柄 + 双击最大化 (design FloatingShell cmp-float-header)。 */}
          <div
            onMouseDown={onHeaderMouseDown}
            onDoubleClick={toggleMaximized}
            className={cn(
              'h-10 shrink-0 flex items-center gap-2 px-3.5 border-b border-ink-border/60 select-none',
              !maximized && 'cursor-move'
            )}
          >
            <PenLine size={14} strokeWidth={2} className="text-ink-fg-2" />
            <span className="text-aux font-medium text-ink-fg">{t('nav.composeNew')}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={maximized ? t('compose.floatRestore') : t('compose.floatMaximize')}
                title={maximized ? t('compose.floatRestore') : t('compose.floatMaximize')}
                onClick={toggleMaximized}
                className="w-7 h-7 grid place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
              >
                {maximized ? (
                  <Minimize2 size={13} strokeWidth={2} />
                ) : (
                  <Maximize2 size={13} strokeWidth={2} />
                )}
              </button>
              <button
                type="button"
                aria-label={t('compose.close')}
                title={t('compose.close')}
                onClick={guardedClose}
                className="w-7 h-7 grid place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
          <ComposePanelInner
            key="new"
            internalId={NEW_COMPOSE_SENTINEL}
            mode="new"
            variant="modal"
            onClose={close}
            guardRef={guardRef}
            initialTo={prefillTo ? [prefillTo] : undefined}
            initialCc={prefillCc ?? undefined}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
