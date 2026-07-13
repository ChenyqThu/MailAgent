// Sprint 2 shell: TitleBar / Sidebar / EmailList / EmailDetail / StatusBar.
// Layout per DESIGN.md §3: 240 (sidebar) + 340 (list) + flex-1 (detail).
//
// S3 W2 — the legacy right-rail AIChatPanel drawer (squeeze column + width
// tween + resize handle + drawer overlay) is deleted with the legacy runtime;
// the AI chat surface in the main window is the AssistantChatModal dock
// (floating / sidebar modes) + its FAB, mounted unconditionally below.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailFilter } from '@shared/state/email-filter'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'
import { ChatModalFab } from '@shared/assistant/modal/ChatModalFab'

const AssistantChatModal = lazy(() =>
  import('@shared/assistant/modal/AssistantChatModal').then((module) => ({
    default: module.AssistantChatModal
  }))
)

// #6 — EmailList 宽度用户可拖拽 (≥lg 固定列模式; <lg 列表占满, 不可拖)。
// clamp + localStorage + try-catch。default 340 = 原 lg:w-[340px] 宽度。
const LIST_WIDTH_DEFAULT = 340
const LIST_WIDTH_MIN = 240
const LIST_WIDTH_MAX = 560
const LIST_WIDTH_PREF = 'mailagent.list.width'
function clampListWidth(px: number): number {
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, px))
}
function readListWidthPref(): number {
  try {
    const raw = Number(localStorage.getItem(LIST_WIDTH_PREF))
    return Number.isFinite(raw) && raw > 0 ? clampListWidth(raw) : LIST_WIDTH_DEFAULT
  } catch {
    return LIST_WIDTH_DEFAULT
  }
}
function writeListWidthPref(px: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_PREF, String(px))
  } catch {
    /* localStorage 在 sandbox / privacy 模式可能拒写; 偏好丢失无伤大雅 */
  }
}

export function InboxLayout(): React.ReactElement {
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const chatVisible = useAIChatPanel((s) => s.visible)
  const [mountChat, setMountChat] = useState(chatVisible)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (chatVisible) setMountChat(true)
  }, [chatVisible])
  // RESPONSIVE-XCUT-01 — <lg(1024) 列表/详情单栏切换：选中邮件 → 详情 absolute
  // 覆盖列表；未选中 → 详情 hidden, 列表占满。≥lg 维持桌面三栏并排（零回归）。
  const belowLg = useIsBelowLg()
  const { t } = useTranslation()
  // Sprint 11 V1.4 — URL ↔ store sync. The route's `validateSearch` clamps
  // unknown values to 'inbox', so `urlView` is always a real EmailView
  // (the optional type just lets `navigate({to:'/'})` skip the search arg).
  // The Sidebar writes view → URL on click; this effect handles the
  // reverse path so deep-links (`/?view=flagged`) hydrate the store.
  const urlView = useSearch({ from: '/', select: (s) => s.view ?? 'inbox' })
  const storeView = useEmailFilter((s) => s.view)
  const setView = useEmailFilter((s) => s.setView)
  useEffect(() => {
    if (urlView !== storeView) setView(urlView)
  }, [urlView, storeView, setView])

  // #6 — EmailList 宽度拖拽 (仅 ≥lg 固定列; <lg 列表占满不挂手柄)。mousedown 记起点,
  // mousemove 直接写 wrapper.style.width 实时跟手 (列表在左侧 → 向右拖变宽,
  // newWidth = startWidth + Δx), clamp [MIN,MAX]; mouseup 写回 state + localStorage。
  // teardown 存 ref, onUp 与 unmount 共用 → 拖拽中卸载不漏 listener / 不留 body
  // col-resize·user-select:none 残留。
  const listWrapperRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState(readListWidthPref)
  const listDragTeardownRef = useRef<(() => void) | null>(null)
  const startListResize = (e: React.MouseEvent): void => {
    const wrapper = listWrapperRef.current
    if (!wrapper) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = wrapper.getBoundingClientRect().width
    let nextWidth = startWidth
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent): void => {
      nextWidth = clampListWidth(startWidth + (ev.clientX - startX))
      // 拖拽期间直接写 inline width 跟手, 不走 React state (避免每帧 re-render)。
      wrapper.style.width = `${nextWidth}px`
    }
    const teardown = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      listDragTeardownRef.current = null
    }
    const onUp = (): void => {
      teardown()
      setListWidth(nextWidth)
      writeListWidthPref(nextWidth)
    }
    listDragTeardownRef.current = teardown
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  useEffect(() => () => listDragTeardownRef.current?.(), [])
  const resizeListByKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    // 列表在左侧: ArrowRight 向右 = 变宽, ArrowLeft 向左 = 变窄 (与拖拽方向一致)。
    const delta = e.key === 'ArrowRight' ? 16 : -16
    setListWidth((w) => {
      const next = clampListWidth(w + delta)
      writeListWidthPref(next)
      return next
    })
  }
  // Sprint 7 review (opus Nit) — removed local `useShortcut('cmd+k', goSearch)`
  // because `GlobalShortcuts` (mounted in App.tsx) now owns ⌘K → command
  // palette. The palette includes a "Go · Search" navigation entry, so the
  // user can still reach /search from the same keystroke — without
  // double-firing two handlers (LIFO + non-consuming open() would have
  // navigated AND opened the palette on the same press).
  return (
    <div className="flex flex-col h-full text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        {/* master-detail 容器 — relative 给 <lg 时 EmailDetail 的 absolute 覆盖
            提供定位上下文（只盖 list, 不盖 Sidebar）。≥lg 内部
            list(340) + detail(flex-1) 并排；<lg list 占满, detail 覆盖(选中) /
            hidden(未选中)。 */}
        <div className="relative flex flex-1 min-h-0 min-w-0">
          {/* #6 — EmailList 宽度 wrapper: ≥lg 固定 listWidth (拖右缘调整 + localStorage
              记忆), <lg 列表占满 (单栏切换, 不挂手柄)。EmailList 自身已改 w-full 由本层控宽;
              拖拽期 mousemove 直接写本 div 的 style.width 跟手, mouseup 才落 state。 */}
          <div
            ref={listWrapperRef}
            className={cn('relative flex min-h-0', belowLg ? 'w-full' : 'lg:shrink-0')}
            style={belowLg ? undefined : { width: listWidth }}
          >
            <EmailList />
            {!belowLg && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('list.resizeHandle', '调整列表宽度')}
                tabIndex={0}
                onMouseDown={startListResize}
                onKeyDown={resizeListByKey}
                className="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 focus:outline-none transition-colors"
              />
            )}
          </div>
          <div
            className={cn(
              'flex min-h-0',
              belowLg ? (activeId !== null ? 'absolute inset-0 z-30' : 'hidden') : 'flex-1 min-w-0'
            )}
          >
            <EmailDetail internalId={activeId} />
          </div>
        </div>
        {/* assistant-modal — dock 内嵌在 master-detail 行内：sidebar 模式 = 可调宽 flex 列（挤压正文）；
            floating 模式 = 自身 position:fixed 脱流（0 flow 占位，不挤压）；最小化 = hidden。
            渲染在行内（非 portal）正是为了让 sidebar 能真正挤压正文。 */}
        {mountChat && (
          <Suspense
            fallback={
              chatVisible ? (
                <Skeleton rows={6} className="h-full w-96 shrink-0 p-6" width="2/3" />
              ) : null
            }
          >
            <AssistantChatModal />
          </Suspense>
        )}
      </div>
      {/* Sprint 17 — 旧 Sprint 5 fixed BatchActionBar 移除. floating bar
          (Sprint 12 设计, components/email/BatchActionBar.tsx) 由 EmailList
          portal 到 document.body, 不再需要在 chrome 这层 mount. */}
      {/* assistant-modal — 正文右下 FAB 入口（最小化态，portal 到 body）。⚠️ dock 本体只在 master-detail
          行内渲染（见上），sidebar 才能挤压正文；这里**不再**第二次挂 AssistantChatModal——之前
          重复挂载导致两个 dock + 两个 useGeneralChat，底部那个挂在 flex-col 根上撑满宽度把列表/正文顶没。 */}
      <ChatModalFab />
      <StatusBar />
    </div>
  )
}
