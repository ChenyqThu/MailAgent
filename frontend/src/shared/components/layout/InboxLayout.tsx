// Sprint 2 shell: TitleBar / Sidebar / EmailList / EmailDetail / StatusBar.
// Layout per DESIGN.md §3: 240 (sidebar) + 340 (list) + flex-1 (detail) =
// min-width 940 (sidebar 240 + list 340 + detail floor 360 reserved for the
// future AI panel column). Sprint 4 inserts the AIChatPanel between the
// detail and the right edge; the grid here doesn't need to change — only
// EmailDetail's max width does.

import { useEffect, useRef, useState } from 'react'
import { useSearch } from '@tanstack/react-router'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailFilter } from '@shared/state/email-filter'

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'
import { AIChatPanel } from '../chat'

// Lane C — AIChatPanel 整列挤压出入场宽度（DESIGN.md §4.1 layout-anim 许可：
// 非列表 / 单实例 / 低频，width tween 可接受）。保持 mockup 的 360px 右栏契约。
const AI_PANEL_WIDTH = 360

export function InboxLayout(): React.ReactElement {
  const activeId = useActiveEmail((s) => s.activeInternalId)
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
  const aiPanelVisible = useAIChatPanel((s) => s.visible)
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
      const target = aiPanelVisible ? AI_PANEL_WIDTH : 0
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
    { dependencies: [aiPanelVisible, reduceMotion] }
  )
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
        <EmailList />
        <EmailDetail internalId={activeId} />
        {/* Lane C — 挤压 wrapper。overflow-hidden 裁掉宽度收缩时溢出的面板内容；
            初始 inline width:0 防首帧闪现（GSAP 接管后由 tween/set 覆写）。
            AIChatPanel 自身仍是 w-[360px] shrink-0，wrapper 收到 0 时把它裁没。 */}
        <div
          ref={wrapperRef}
          className="overflow-hidden shrink-0 flex min-h-0"
          style={{ width: 0 }}
        >
          {mountPanel && <AIChatPanel />}
        </div>
      </div>
      {/* Sprint 17 — 旧 Sprint 5 fixed BatchActionBar 移除. floating bar
          (Sprint 12 设计, components/email/BatchActionBar.tsx) 由 EmailList
          portal 到 document.body, 不再需要在 chrome 这层 mount. */}
      <StatusBar />
    </div>
  )
}
