import { useManagedBrowserUi } from './managed-browser-ui'
import { selectActiveTab, useTabWorkspace } from './tab-workspace'
import { openBrowserTab } from './tab-workspace-bridge'

const HTTP_URL_RE = /^https?:\/\//i

/** Return true for safe http(s) URLs that can be opened in the built-in browser. */
export function isHttpUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!HTTP_URL_RE.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Hand off an http(s) URL from chat / workspace inspector into MailAgent's built-in browser.
 * Opens the right-hand chat sidebar browser on wide viewports when in a chat tab, otherwise
 * opens/focuses the dedicated browser tab.
 */
export function openUrlInBuiltInBrowser(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!isHttpUrl(trimmed)) return false

  useManagedBrowserUi.getState().setPendingUrl(trimmed)

  const activeKind = selectActiveTab(useTabWorkspace.getState())?.kind
  if (activeKind === 'browser') {
    return true
  }
  const wideViewport = typeof window !== 'undefined' ? window.innerWidth >= 900 : true
  if (activeKind === 'chat' && wideViewport) {
    useManagedBrowserUi.getState().openSidebar()
    return true
  }
  openBrowserTab()
  return true
}
