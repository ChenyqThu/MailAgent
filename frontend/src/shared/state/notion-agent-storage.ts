// Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — single SSoT for
// the Notion Agent binding localStorage keys + the custom DOM event that
// SettingsPage dispatches after a write so an already-mounted AIChatPanel
// picks up the change without a remount.
//
// Both SettingsPage.tsx and AIChatPanel.tsx used to ship their own copy of
// these three string constants. A typo in either (e.g. renaming the key on
// one side only) silently broke the live-update contract from Sprint 4
// (codex L carry-forward). Centralizing keeps the contract tight.

export const STORAGE_AGENT_ID = 'mailagent.notionAgent.pageId'
export const STORAGE_AGENT_NAME = 'mailagent.notionAgent.name'

/** Custom event SettingsPage dispatches after persisting the Notion Agent
 *  binding. AIChatPanel listens via useSyncExternalStore so the panel
 *  re-renders with the new agent_page_id without a remount. The browser's
 *  built-in `storage` event only fires cross-tab, which doesn't help inside
 *  a single Electron BrowserWindow. */
export const STORAGE_CHANGE_EVENT = 'mailagent:notion-agent-storage'

/** Fire-and-forget the change event. Wrapped in try/catch because SSR /
 *  privacy modes can throw on `window.dispatchEvent`. */
export function dispatchAgentStorageEvent(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(STORAGE_CHANGE_EVENT))
    }
  } catch {
    // No-op — the in-process state still got updated via setQueryData.
  }
}
