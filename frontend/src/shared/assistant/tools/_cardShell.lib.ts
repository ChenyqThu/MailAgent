// 从 _cardShell.tsx 拆出（08-02 review F9）：react-refresh/only-export-components 要求一个文件
// 只导出组件。本文件是卡片外壳的**纯逻辑**面（phase 派生 / 错误抽取 / edit-tier 侧信道 POST），
// 零 JSX —— 组件仍在 _cardShell.tsx，两边合起来等于原来那一个文件。

import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { resolveAiGatewayBaseUrl } from '../runtime/flags'

export type CardPhase =
  | 'pending' // approval-requested: the card asks the user to approve / edit / reject
  | 'authorized' // approved, executing or awaiting the result
  | 'done' // output-available: the write ran, show the result
  | 'rejected' // the user rejected (output-denied)
  | 'expired' // the approval was cancelled / expired without a decision
  | 'error' // output-error

/** Derive the card phase from the assistant-ui tool part props. The `approval` gate (approved
 *  undefined + no resolution) is the pending signal; `result`/`isError`/`status` cover the
 *  terminal states. Robust to a reloaded part that carries only a result (no live approval). */
export function deriveCardPhase(
  props: Pick<ToolCallMessagePartProps, 'approval' | 'result' | 'isError' | 'status'>
): CardPhase {
  const { approval, result, isError, status } = props
  if (isError === true || (status?.type === 'incomplete' && status.reason === 'error')) {
    return 'error'
  }
  if (approval?.resolution === 'cancelled' || approval?.resolution === 'expired') return 'expired'
  if (approval && approval.approved === false) return 'rejected'
  if (result !== undefined && result !== null) return 'done'
  // approval gate still open (approved === undefined, no resolution) → ask the user.
  if (approval && approval.approved === undefined) return 'pending'
  // approved but no result yet (executing), or a reloaded part with neither — treat as
  // authorized/running so the card shows a calm "running" state rather than empty.
  return approval?.approved === true ? 'authorized' : 'done'
}

/** Longest error detail a card will render — a schema-validation errorText embeds the whole
 *  rejected input, which for a draft is the entire body. */
const ERROR_DETAIL_MAX = 240

/** Pull a SHORT, actionable line out of a failed tool part, or null when there is nothing better
 *  than the card's generic sentence (issue #70 — 8 identical "草稿操作失败，请重试" cards told the
 *  user nothing, while the part carried the exact reason all along).
 *
 *  assistant-ui delivers a tool-error part as `result = { error: <errorText> }` (react-ai-sdk
 *  convertMessage). Two errorText shapes reach us:
 *    - a domain failure, already short and coded: `[E_KOS_NETWORK] MCP request failed: …`;
 *    - an ai@7 input-validation failure, where the useful part is the zod issue list buried
 *      after `Error message:` and behind a full JSON dump of the rejected input.
 *  The second is unwrapped to `field: message`; anything else is passed through and clamped. */
export function toolErrorDetail(result: unknown): string | null {
  const raw =
    typeof result === 'string'
      ? result
      : typeof (result as { error?: unknown } | null)?.error === 'string'
        ? (result as { error: string }).error
        : null
  if (raw == null) return null
  const text = raw.trim()
  if (text.length === 0) return null

  const marker = text.indexOf('Error message:')
  if (marker >= 0) {
    const tail = text.slice(marker + 'Error message:'.length).trim()
    try {
      const issues: unknown = JSON.parse(tail)
      if (Array.isArray(issues) && issues.length > 0) {
        const first = issues[0] as { path?: unknown; message?: unknown }
        const message = typeof first.message === 'string' ? first.message : null
        if (message != null) {
          const path = Array.isArray(first.path) ? first.path.join('.') : ''
          const one = path.length > 0 ? `${path}: ${message}` : message
          const more = issues.length > 1 ? ` (+${issues.length - 1})` : ''
          return clampDetail(one + more)
        }
      }
    } catch {
      /* not the zod shape — fall through to the raw text */
    }
  }
  return clampDetail(text)
}

function clampDetail(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > ERROR_DETAIL_MAX ? `${one.slice(0, ERROR_DETAIL_MAX)}…` : one
}

/** POST the user's edited fields to the gateway resolve side-channel (edit-tier only). The
 *  gateway overlays them onto the pending approval's original input (identity pinned) so the
 *  next streamText call's execute runs the edit — WITHOUT changing the ai@6 history input, so
 *  the signed approval stays valid. Resolves on 2xx; throws with the typed error code on
 *  failure so the card can surface it and NOT proceed to approve. */
export async function postApprovalEdit(
  toolCallId: string,
  editedInput: Record<string, unknown>
): Promise<void> {
  const base = resolveAiGatewayBaseUrl()
  // `''` (same-origin web proxy) is a VALID base but falsy — null-check explicitly, never `!base`.
  if (base == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${base}/api/ai/approval/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId, editedInput })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(code)
  }
}

