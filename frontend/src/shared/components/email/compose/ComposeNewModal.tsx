// 写新邮件 (compose new) 居中模态外壳。
//
// 写新邮件是「全局动作」(不属于任何已打开邮件)，故脱离三栏布局，用居中模态：
// backdrop + 居中 glass-pop 卡片，portal 到 document.body 避开父级 overflow 裁剪。
// 卡片内复用 ComposePanelInner (mode='new' + variant='modal')——表单 UI 与
// reply/forward/draft-edit 完全一致，只是外壳从「detail 列」换成「模态卡片」。
//
// 进退场动效 (frontend §8 / motion-gsap §4)：useExitAnimation 把卸载推迟到退场
// 动画播完 —— backdrop 淡入 + 卡片 autoAlpha/y/scale 进场, 关闭时反向播完再卸载
// (替代 `{open && …}` 的同步 return null 硬切)。
//
// 关闭路径: 点 backdrop / ESC (ComposePanelInner 自带 window keydown handler →
// onClose) / 发送成功 / 放弃。挂载在 RootLayout (router-instance.tsx) 全局一次，
// 任意路由都能由侧边栏按钮或 ⌘N 打开。

import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useComposeNewStore } from '@shared/state/compose-new'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

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
  // 进退场动效 (居中模态: root=backdrop + 卡片 data-anim-card)。shouldRender 在退场
  // 动画播完前保持 true, 卡片卸载推迟到动画结束。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })
  // focus-trap: Tab 在卡片内循环, 焦点逃出时下次 Tab snap 回; root (backdrop,
  // tabIndex=-1) 作 fallback 焦点目标。ESC 关闭由 ComposePanelInner 的 window
  // keydown handler 接管 (此处 onKeyDown 只管 Tab)。
  const { dialogRef, handleTab } = useFocusTrap({ open, fallbackRef: scopeRef })

  if (!shouldRender) return null

  return createPortal(
    <div
      ref={scopeRef}
      tabIndex={-1}
      onClick={close}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 py-[6vh] bg-black/40 focus:outline-none"
    >
      {/* 卡片 — 真浮层材质 glass-pop (20px backdrop-blur + 86% 不透明基底 + border +
          pop-shadow; data-surface='solid' 档自动实底)。data-anim-card = 进退场动画
          目标。onClick stopPropagation 防点卡片冒泡到 backdrop 误关。固定高度让正文
          editor (flex-1) 有确定空间撑满 + 滚动。 */}
      <div
        ref={dialogRef}
        data-anim-card
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.composeNew')}
        onClick={(e) => e.stopPropagation()}
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
