// Sprint 14 PR E — popout-window chrome.
//
// Rendered by App.tsx when usePopoutMode.isPopout is true (set by
// renderer/main.tsx's pre-render boot from window.location.search).
// The popout deliberately bypasses TanStack Router: there's no
// Sidebar, no EmailList, no settings nav — just a single email's
// chat panel pinned full-window. The user opened this window
// specifically to focus the AI conversation, often pinned next to
// Mail.app while replying.
//
// The shell hydrates `useActiveEmail` from the popout's emailId before
// rendering AIChatPanel so the panel's `useEmailChat(activeId)`
// resolves to the right session on first render (no `null → 123` flip
// that would trigger a stale-session render).

import { useEffect } from 'react'

import { useActiveEmail } from '@shared/state/active-email'
import { usePopoutMode } from '@shared/state/popout-mode'

import { AIChatPanel } from './AIChatPanel'

export function PopoutShell(): React.ReactElement {
  const emailId = usePopoutMode((s) => s.emailId)
  const setActive = useActiveEmail((s) => s.setActive)

  // Hydrate the active-email store from the popout's URL once. Effect
  // (not a render-time write) so we don't trip `setState-in-render`
  // lints, and so a React 19 strict-mode double-invoke doesn't double-
  // dispatch the setter on first mount.
  useEffect(() => {
    if (emailId !== null) setActive(emailId)
  }, [emailId, setActive])

  return (
    // 主题 v2 — 去掉不透明 bg-ink-2: popout 窗同样走「一块玻璃」, 基底
    // tint 由 body::before 提供 (solid/降级路径它会画不透明 ink-0)。
    <div className="h-screen w-screen flex">
      <AIChatPanel fullScreen />
    </div>
  )
}
