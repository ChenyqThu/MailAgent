// Auto-approval mode — renderer-local preference (localStorage-backed), mirrors autoTitle.ts.
//
// Controls whether the AI SDK gateway's write tools require an explicit user approval card:
//   'always'          (DEFAULT) — every write tool is approval-gated (each shows a confirmation
//                                 card before it runs). Byte-identical to the pre-toggle behaviour.
//   'auto-reversible'           — reversible preview-tier writes (flag / archive / pin / resync /
//                                 memory write & delete) execute WITHOUT a card; edit-tier
//                                 (email_draft_reply) still asks; the high-risk blocking send
//                                 (email_prepare_send) ALWAYS asks (irreversible outbound floor).
//
// 🔴 The send tool is NEVER auto-approved in any mode — the gateway's auditedSendTool.needsApproval
//    hard-returns true (the safety floor lives in the gateway, not in this preference). This setting
//    only relaxes reversible preview-tier writes.
//
// Persisted as plain localStorage (a renderer preference, like the auto-title mode) — NOT env, so it
// needs no serve-api round-trip and applies instantly. Best-effort: a blocked localStorage falls back
// to the default ('always'). The value rides the chat request body to the gateway (缺省不传 = always),
// so 默认态 / flag-off is byte-identical (the gateway reads body.approvalMode, default 'always').

import { useSyncExternalStore } from 'react'

export type ApprovalMode = 'always' | 'auto-reversible'

const MODE_KEY = 'mailagent.chat.approvalMode'
/** Same-tab change notification (the `storage` event only fires in OTHER tabs/windows). */
const CHANGE_EVENT = 'mailagent:approvalMode-changed'

/** Default = strictest: every write tool asks. So an absent / blocked preference never silently
 *  relaxes approval. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'always'

export function readApprovalMode(): ApprovalMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'auto-reversible' ? 'auto-reversible' : 'always'
  } catch {
    return DEFAULT_APPROVAL_MODE
  }
}

export function writeApprovalMode(mode: ApprovalMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
    // Notify same-window subscribers (useApprovalMode) — the native `storage` event is cross-tab only.
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    /* best-effort — a blocked localStorage just keeps the default ('always') */
  }
}

/** Subscribe to the persisted approval mode so a Settings change applies instantly (same window via
 *  the CHANGE_EVENT, other windows via the native `storage` event) without a manual remount. */
export function useApprovalMode(): ApprovalMode {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(CHANGE_EVENT, onChange)
      window.addEventListener('storage', onChange)
      return () => {
        window.removeEventListener(CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
      }
    },
    readApprovalMode,
    () => DEFAULT_APPROVAL_MODE
  )
}
