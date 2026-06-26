// Sprint 2 shell: TitleBar / Sidebar / EmailList / EmailDetail / StatusBar.
// Layout per DESIGN.md §3: 240 (sidebar) + 340 (list) + flex-1 (detail) =
// min-width 940 (sidebar 240 + list 340 + detail floor 360 reserved for the
// future AI panel column). Sprint 4 inserts the AIChatPanel between the
// detail and the right edge; the grid here doesn't need to change — only
// EmailDetail's max width does.

import { useEffect, useRef, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useIsBelowLg, useIsBelowXl } from '@shared/hooks/useMediaQuery'
import { useActiveEmail } from '@shared/state/active-email'
import { hideAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailFilter } from '@shared/state/email-filter'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'
import { AIChatPanel } from '../chat'
import { ChatModalFab } from '@shared/assistant/modal/ChatModalFab'
import { AssistantChatModal } from '@shared/assistant/modal/AssistantChatModal'
import { isAssistantModalEnabled } from '@shared/assistant/runtime/flags'

// Lane C — AIChatPanel 整列挤压出入场宽度（DESIGN.md §4.1 layout-anim 许可：
// 非列表 / 单实例 / 低频，width tween 可接受）。360 = mockup 默认右栏宽，F3a 起
// 改为用户可拖拽调整 + localStorage 记忆，clamp 到 [MIN, MAX]。
const AI_PANEL_WIDTH_DEFAULT = 360
const AI_PANEL_WIDTH_MIN = 320
const AI_PANEL_WIDTH_MAX = 720

// F3a — 面板宽度偏好持久化（key + try-catch 范式同 AIChatPanel.tsx
// readBackendKindPref/writeBackendKindPref：localStorage 在 sandbox/隐私模式
// 可能拒访问，失败回退默认 / 静默丢弃）。
const PANEL_WIDTH_PREF = 'mailagent.chat.panelWidth'
function clampPanelWidth(px: number): number {
  return Math.min(AI_PANEL_WIDTH_MAX, Math.max(AI_PANEL_WIDTH_MIN, px))
}
function readPanelWidthPref(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_PREF))
    return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : AI_PANEL_WIDTH_DEFAULT
  } catch {
    return AI_PANEL_WIDTH_DEFAULT
  }
}
function writePanelWidthPref(px: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_PREF, String(px))
  } catch {
    /* localStorage 在 sandbox / privacy 模式可能拒写; 偏好丢失无伤大雅 */
  }
}

// #6 — EmailList 宽度用户可拖拽 (≥lg 固定列模式; <lg 列表占满, 不可拖)。范式同上面
// AI 面板宽度 (clamp + localStorage + try-catch)。default 340 = 原 lg:w-[340px] 宽度。
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
  // RESPONSIVE-XCUT-01 — <lg(1024) 列表/详情单栏切换：选中邮件 → 详情 absolute
  // 覆盖列表；未选中 → 详情 hidden, 列表占满。≥lg 维持桌面三栏并排（零回归）。
  const belowLg = useIsBelowLg()
  // RESPONSIVE-XCUT-05 — <xl(1280) AI panel 由挤压列改 drawer overlay。窄屏下
  // 360px 挤压会把正文挤到 <320 (甚至 <md 时 360 > 视口宽导致布局崩)，故 <xl
  // 改 fixed 右侧抽屉 (不挤压) + backdrop。
  const belowXl = useIsBelowXl()
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
  // Sprint 10 user-acceptance — AIChatPanel was forced-mounted in the
  // 1280px layout, leaving EmailDetail < 320px wide. Now it's an on-demand
  // overlay column toggled via the toolbar icon, ⌘L, or any AI Agents
  // sidebar entry.
  // assistant-modal flag-on：旧 AIChatPanel 退役 —— `visible` 由 floating modal（AssistantChatModal）
  // 接管，这里强制 aiPanelVisible=false 让挤压列 width 恒 0 + 面板不挂载，避免 modal 与旧抽屉同时展开
  // （plan P2 中间态）。isAssistantModalEnabled() 是 build-time 常量 → flag-off 时 = raw，字节级原行为。
  const aiPanelVisibleRaw = useAIChatPanel((s) => s.visible)
  const aiPanelVisible = isAssistantModalEnabled() ? false : aiPanelVisibleRaw
  // Lane C — 挤压（width tween），不是覆盖：AIChatPanel 始终 mount（一旦首次
  // 打开后不再卸载，保留 chat state / 滚动位置），用 overflow:hidden 的 wrapper
  // 在 0 ↔ 360px 间 tween width 来"推开"正文。首帧 visible=false 时 wrapper
  // 初始 width:0，避免闪现。
  //
  // 副作用处理：AIChatPanel 的 useEmailChat 会在 emailId 切换时 listSessions
  // (IPC)，notion/detail/ai 查询也跟随 activeId。若 app 启动即 always-mount，
  // 这些会在面板不可见时空跑。折中：用 mountedOnce 延迟挂载面板本体——首次打开
  // 时 wrapper 0→360 与挂载同时发生（挤压作用在 wrapper 上，不受影响），之后
  // 关/开只 tween width 不再卸载（满足"始终 mount"+ 保留状态），且首次打开前
  // 零后台 IPC。
  const reduceMotion = useReducedMotion()
  const wrapperRef = useRef<HTMLDivElement>(null)
  // F3a — 挤压列模式下面板宽度由用户拖左边缘调整, 取代写死的 360 作为 GSAP 的
  // "打开"目标; reload 后从 localStorage 恢复。drawer (belowXl) 不用此值。
  const [panelWidth, setPanelWidth] = useState(readPanelWidthPref)
  // keep-mounted latch: 初值 = 当前可见态（启动即可见时无一帧延迟），首次可见后
  // 永久 true（绝不回 false → 保留 chat state / 滚动）。effect 接首次 false→true
  // 的转变（首次打开晚一帧挂载, 主理人已接受）。
  const [mountPanel, setMountPanel] = useState(aiPanelVisible)
  useEffect(() => {
    // 把 external store 的 visible 信号翻译成一次性 "已挂载" latch（同
    // useNewlyAddedIds 的 effect-body setState 正解）；只单向 false→true,
    // 不会级联。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (aiPanelVisible) setMountPanel(true)
  }, [aiPanelVisible])

  useGSAP(
    () => {
      const wrapper = wrapperRef.current
      if (!wrapper) return
      // <xl drawer 模式：不挤压, 清掉 GSAP 设的 inline width, 交给 CSS (fixed +
      // translate-x) 接管出入场; 宽度由 AIChatPanel 自身 (w-[360px] max-w-[92vw])。
      if (belowXl) {
        gsap.set(wrapper, { clearProps: 'width' })
        return
      }
      // F3a — "打开"目标 = 用户选定宽度 (panelWidth), 关闭仍 = 0。拖拽中 mousemove
      // 直接写 wrapper.style.width 实时跟手, mouseup 写回 panelWidth state → 这里
      // 收敛 (target 已等于当前 inline width, 无可见跳变)。
      const target = aiPanelVisible ? panelWidth : 0
      if (reduceMotion) {
        // reduced-motion：直接切到目标 width，不播动画。
        gsap.set(wrapper, { width: target })
        return
      }
      gsap.to(wrapper, {
        width: target,
        duration: aiPanelVisible ? DUR.base : DUR.fast,
        // width 是 layout 动画——动画期间标 will-change，结束清掉（§4.1 红线）。
        onStart: () => {
          wrapper.style.willChange = 'width'
        },
        onComplete: () => {
          wrapper.style.willChange = ''
        }
      })
    },
    { dependencies: [aiPanelVisible, reduceMotion, belowXl, panelWidth] }
  )

  // F3a — 拖左边缘调宽 (仅 ≥xl 挤压列；<xl drawer 不挂手柄)。mousedown 记录起点,
  // mousemove 直接写 wrapper.style.width 实时跟手 (面板在右侧 → 向左拖变宽，故
  // newWidth = startWidth - Δx)，clamp 到 [MIN, MAX]; mouseup 写回 state +
  // localStorage 并解绑。拖拽中加 select-none / col-resize cursor 到 body 防选中。
  //
  // 泄漏防护 (review MEDIUM-1)：active drag 的 teardown (解绑两个 document
  // listener + 复原两个 body style) 存进 ref，onUp 复用它，且 unmount effect
  // 卸载时跑同一份 —— 否则拖拽中组件卸载 / handle 因 aiPanelVisible·belowXl·
  // mountPanel 翻转被移除会漏掉 onUp，留下游离 listener + body 永久卡
  // col-resize / user-select:none。
  const dragTeardownRef = useRef<(() => void) | null>(null)
  const startResize = (e: React.MouseEvent): void => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    e.preventDefault()
    // 干净接管 inline width (review LOW)：杀掉可能在播的 open/close tween,
    // 避免开面板 220ms 内抓手柄时 GSAP 与 drag 抢 width。
    gsap.killTweensOf(wrapper)
    const startX = e.clientX
    const startWidth = wrapper.getBoundingClientRect().width
    let nextWidth = startWidth
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      nextWidth = clampPanelWidth(startWidth - (ev.clientX - startX))
      // 拖拽期间直接写 inline width 跟手, 不走 React state (避免每帧 re-render)。
      wrapper.style.width = `${nextWidth}px`
    }
    const teardown = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      dragTeardownRef.current = null
    }
    const onUp = (): void => {
      teardown()
      setPanelWidth(nextWidth)
      writePanelWidthPref(nextWidth)
    }
    dragTeardownRef.current = teardown
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  // unmount 时跑掉残留的 drag teardown (拖拽中卸载兜底)。
  useEffect(() => () => dragTeardownRef.current?.(), [])

  // F3a 键盘可达 (review a11y)：handle 已 role="separator"，补 ArrowLeft/Right
  // ±16px 调宽 + clamp + 持久化，让非鼠标用户也能调。
  const resizeByKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    // 面板在右侧：ArrowLeft 向左 = 变宽，ArrowRight 向右 = 变窄 (与拖拽方向一致)。
    const delta = e.key === 'ArrowLeft' ? 16 : -16
    setPanelWidth((w) => {
      const next = clampPanelWidth(w + delta)
      writePanelWidthPref(next)
      return next
    })
  }

  // #6 — EmailList 宽度拖拽 (仅 ≥lg 固定列; <lg 列表占满不挂手柄)。范式同 AI 面板拖拽:
  // mousedown 记起点, mousemove 直接写 wrapper.style.width 实时跟手 (列表在左侧 → 向右
  // 拖变宽, newWidth = startWidth + Δx), clamp [MIN,MAX]; mouseup 写回 state +
  // localStorage。teardown 存 ref, onUp 与 unmount 共用 → 拖拽中卸载不漏 listener /
  // 不留 body col-resize·user-select:none 残留。
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
            提供定位上下文（只盖 list, 不盖 Sidebar / AI panel）。≥lg 内部
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
        {/* Lane C — AI panel wrapper。≥xl: 挤压列 (width tween 0↔360 收缩
            master-detail → detail 收缩, list 保持 340, 零桌面回归)。<xl: drawer
            overlay (fixed 右侧, translate-x 滑入, 不挤压, 见 belowXl 分支)。
            backdrop 点击关闭, z-30 < drawer z-40。 */}
        {belowXl && aiPanelVisible && (
          <button
            type="button"
            aria-label={t('chat.closePanel')}
            onClick={hideAIChatPanel}
            className="fixed inset-0 z-30 bg-black/30"
          />
        )}
        <div
          ref={wrapperRef}
          className={cn(
            'flex min-h-0',
            belowXl
              ? cn(
                  'fixed right-0 top-titlebar bottom-statusbar z-40',
                  'transition-transform duration-base ease-standard motion-reduce:transition-none',
                  aiPanelVisible ? 'translate-x-0' : 'translate-x-full pointer-events-none'
                )
              : 'relative overflow-hidden shrink-0'
          )}
          style={belowXl ? undefined : { width: 0 }}
        >
          {/* F3a — 左边缘拖拽手柄 (仅 ≥xl 挤压列 + 面板打开时挂)。细条 w-1,
              col-resize cursor, z-50 盖在面板内容之上接 mousedown。drawer
              模式 (belowXl) 不挂 — 抽屉宽度固定不可拖。 */}
          {!belowXl && aiPanelVisible && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('chat.resizePanel')}
              aria-valuenow={panelWidth}
              aria-valuemin={AI_PANEL_WIDTH_MIN}
              aria-valuemax={AI_PANEL_WIDTH_MAX}
              tabIndex={0}
              onMouseDown={startResize}
              onKeyDown={resizeByKey}
              className={cn(
                'absolute left-0 top-0 bottom-0 w-1 z-50 cursor-col-resize hover:bg-coral/30',
                'focus:outline-none focus-visible:bg-coral/50'
              )}
            />
          )}
          {mountPanel && <AIChatPanel fillWrapper={!belowXl} />}
        </div>
      </div>
      {/* Sprint 17 — 旧 Sprint 5 fixed BatchActionBar 移除. floating bar
          (Sprint 12 设计, components/email/BatchActionBar.tsx) 由 EmailList
          portal 到 document.body, 不再需要在 chrome 这层 mount. */}
      {/* assistant-modal P1/P2 — 正文右下 FAB 入口（最小化态）+ 展开后的 floating modal（两者 portal 到
          body，FAB↔modal 由 useAIChatPanel.visible 互斥：visible 时 modal 显示、FAB 自隐）。flag-on only。 */}
      {isAssistantModalEnabled() && <ChatModalFab />}
      {isAssistantModalEnabled() && <AssistantChatModal />}
      <StatusBar />
    </div>
  )
}
