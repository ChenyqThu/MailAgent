// chat-ui W4 (follow-up chips relocation) — thread-level readOnly flag, made visible to
// PER-MESSAGE components.
//
// AssistantThread / AgentThread already take a `readOnly` prop (record view / retired-backend
// history: render prior messages, suppress the composer). Follow-up chips used to be gated by
// that same prop at the THREAD layer (`{!readOnly && <FollowupSuggestions/>}` next to the
// composer); now that the chips render inside each AssistantMessage/AgentAssistantMessage (a
// per-message component instantiated by assistant-ui's `components` map, which takes no extra
// props), there is no direct prop path from the thread down to them — hence this context.
//
// Default false (no provider ancestor = live/writable thread), matching the pre-existing
// `readOnly = false` default on both thread components.

import { createContext, useContext } from 'react'

export const ThreadReadOnlyContext = createContext(false)

export function useThreadReadOnly(): boolean {
  return useContext(ThreadReadOnlyContext)
}
