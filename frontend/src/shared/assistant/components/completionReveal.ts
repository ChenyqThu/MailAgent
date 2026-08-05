// Split out of action-bar.tsx (chat-ui W4, 0804 dogfood 1d) — mirrors the composerControls.tsx /
// composerControlsContext.ts split (08-02 review F9): react-refresh/only-export-components wants a
// file to export EITHER components OR non-component values, not both. action-bar.tsx exports two
// components (AssistantActionBar, UserActionBar); FollowupSuggestions.tsx needs this hook too (to
// share the exact same 380ms reveal gate/timing — one fade, not a second independent animation) —
// so the hook lives here, and action-bar.tsx imports it like any other consumer.

import { useEffect, useState } from 'react'
import { useAuiState } from '@assistant-ui/react'

// W5 回答完成收束 —— action row 在「回答刚写完」这一刻做一次 opacity 0→1 淡入（§8 slow 380ms），
// 而不是硬生生地出现。判据 = `thread.isRunning`，与 ActionBarPrimitive.Root 自己的 `hideWhenRunning`
// 同一口真值：running 期间 Root 返回 null（本 hook 同步把 revealed 打回 false），落地那一帧 Root 挂上
// 但仍是 opacity-0，下一帧 rAF 翻 true → transition 才有得跑（直接 opacity-100 挂载不会触发过渡）。
// 只给 isLast 那条用：非最新消息的 bar 是 hover 才现的（email 面甚至是 hover 才挂载），套上 380ms
// 会把「悬停即现」拖成拖沓 —— 那条路径逐字不动。
export function useCompletionReveal(): boolean {
  const running = useAuiState((s) => s.thread.isRunning)
  const [revealed, setRevealed] = useState(false)
  // Adjust-on-prop-change（react.dev，与 useStallLevel / ReasoningText 同范式）：复位写在 render 里，
  // 不写进 effect —— 免得 set-state-in-effect 的级联，也保证「新一轮开始」与「Root 消失」同一帧发生。
  const [prevRunning, setPrevRunning] = useState(running)
  if (prevRunning !== running) {
    setPrevRunning(running)
    if (running && revealed) setRevealed(false)
  }
  useEffect(() => {
    if (running) return
    const id = window.requestAnimationFrame(() => setRevealed(true))
    return (): void => window.cancelAnimationFrame(id)
  }, [running])
  return revealed
}
