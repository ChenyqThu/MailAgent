// 写新邮件 (compose new) 居中模态外壳。
//
// 写新邮件是「全局动作」(不属于任何已打开邮件)，故脱离三栏布局，用居中模态：
// 遮罩 + 居中 glass-3 卡片，portal 到 document.body 避开父级 overflow 裁剪。
// 卡片内复用 ComposePanelInner (mode='new' + variant='modal')——表单 UI 与
// reply/forward/draft-edit 完全一致，只是外壳从「detail 列」换成「模态卡片」。
//
// 关闭路径: 遮罩点击 / ESC (ComposePanelInner 自带 window keydown handler →
// onClose) / 发送成功 / 放弃。挂载在 RootLayout (router-instance.tsx) 全局一次，
// 任意路由都能由侧边栏按钮或 ⌘N 打开。

import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useComposeNewStore } from '@shared/state/compose-new'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'

import { ComposePanelInner } from './ComposePanel'

/** 写新邮件用的哨兵 internalId — 无对应 email_metadata 行。draft.ts / serve-api
 *  adapter 与 service _prepare_draft 对 mode='new' 放宽 record 强制 (sync_store.get(-1)
 *  =None → {}), 走 explicit_body 分支零线程派生。ComposePanelInner 所有 query 的
 *  `internalId >= 0` 守卫天然 false。 */
const NEW_COMPOSE_SENTINEL = -1

export function ComposeNewModal(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useComposeNewStore((s) => s.open)
  const close = useComposeNewStore((s) => s.close)
  // focus-trap: 与既有模态 (KeyboardHelpModal / CommandPalette) 一致 — Tab 在卡片
  // 内循环, 焦点逃出 (点遮罩外) 时下次 Tab snap 回。overlay button 作 fallback
  // (tabIndex=-1: 可程序聚焦但不进 Tab 序)。ESC 关闭仍由 ComposePanelInner 的
  // window keydown handler 接管 (此处 onKeyDown 只管 Tab)。
  const overlayRef = useRef<HTMLButtonElement>(null)
  const { dialogRef, handleTab } = useFocusTrap({ open, fallbackRef: overlayRef })

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-[6vh]">
      {/* 遮罩 — 点击关闭。tabIndex=-1 让它不进 Tab 序 (否则 Tab 可停在遮罩上)。
          ESC 由 ComposePanelInner 的 window handler 接管。 */}
      <button
        ref={overlayRef}
        type="button"
        tabIndex={-1}
        aria-label={t('compose.discard')}
        onClick={close}
        className="absolute inset-0 bg-black/40"
      />
      {/* 卡片 — 真浮层材质走 .glass-pop (20px backdrop-blur + 86% 不透明基底 +
          border + pop-shadow; data-surface='solid' 档自动实底不透明)。glass-3 等
          面板类【无 backdrop-filter】(靠主窗口 body::before 全局玻璃层), 浮在暗遮罩
          上会直接透出遮罩、文本发灰 —— 浮层必须用 glass-pop。固定高度让正文 editor
          (flex-1) 有确定空间撑满 + 滚动。 */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.composeNew')}
        onKeyDown={(e) => handleTab(e)}
        className="relative w-[720px] max-w-[92vw] h-[min(760px,86vh)] flex flex-col rounded-2xl glass-pop overflow-hidden"
      >
        <ComposePanelInner
          key="new"
          internalId={NEW_COMPOSE_SENTINEL}
          mode="new"
          variant="modal"
          onClose={close}
        />
      </div>
    </div>,
    document.body
  )
}
