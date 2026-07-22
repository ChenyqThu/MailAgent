// 1.5.0 dogfood (task 07-07) — SimpleApprovalCard: the identity-only edit-tier approval card shared
// by the tools whose approval needs NO field editor, just approve / reject over a pinned identity
// value:
//   web_fetch (URL) · web_search (query) · custom_agent_delete (agent id) · custom_agent_run_now
//   · notion_agent_chat (prompt — task 07-21).
//
// 🔴 The bug it fixes: before this card these four edit-tier tools fell through to the buttonless
//    generic ToolTraceCard, which rendered the requires-action (approval-paused) state as a
//    PERMANENT spinner. Their only approve surface was the dynamic island — so with the island off
//    (Ping Island not installed / not running) the chat was stuck "spinning" with no way to approve.
//
// This card wires the SAME native path the rich cards use: respondToApproval({approved}) records the
// decision, and the runtime's sendAutomaticallyWhen (shouldResumeAfterToolApprovalResponses) re-POSTs
// /api/ai/chat — resuming the run entirely in-panel, with NO island in the loop (通道 A). It reuses
// _cardShell (CardFrame / ApprovalActions / TerminalBanner / deriveCardPhase) verbatim; there is no
// resolve side-channel and no editable field (identity is pinned, matching these tools' schema — the
// value the user sees is exactly what will run).

import { Globe, NotebookPen, Play, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'

/** Per-tool copy: the i18n key suffix (title + label live under chat.simpleApprovalCard.<key>) and
 *  which model-input field carries the pinned identity value the user reviews. (Icons live in
 *  `iconFor` — a render-time function, not a module-scope JSX const, mirroring ExecApprovalCard /
 *  ToolTraceCard.) */
interface ToolSpec {
  key: string
  field: string
  /** 07-21 (codex MEDIUM-1) — an optional continuation-id field (e.g. notion_agent_chat's
   *  thread_id): when the model input carries it, the card shows a「续接会话 <id>」line so the user
   *  reviews that this call continues a prior conversation, not a fresh one. Absent → not rendered. */
  continuationField?: string
}

const SPECS: Record<string, ToolSpec> = {
  web_fetch: { key: 'webFetch', field: 'url' },
  web_search: { key: 'webSearch', field: 'query' },
  custom_agent_delete: { key: 'customAgentDelete', field: 'agent_id' },
  custom_agent_run_now: { key: 'customAgentRunNow', field: 'agent_id' },
  // task 07-21 — notion_agent_chat previews the pinned `prompt` + (if a follow-up) the thread_id.
  notion_agent_chat: { key: 'notionAgentChat', field: 'prompt', continuationField: 'thread_id' }
}

function iconFor(toolName: string): React.ReactNode {
  if (toolName === 'web_search') return <Search size={13} strokeWidth={2} />
  if (toolName === 'custom_agent_delete') return <Trash2 size={13} strokeWidth={2} />
  if (toolName === 'custom_agent_run_now') return <Play size={13} strokeWidth={2} />
  if (toolName === 'notion_agent_chat') return <NotebookPen size={13} strokeWidth={2} />
  return <Globe size={13} strokeWidth={2} />
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/** The pinned identity value to review — the tool's key arg (url / query / agent_id). Degrades to a
 *  compact JSON summary of the args when the expected field is absent, and to '' when there is
 *  nothing (the caller substitutes a localized "(no arguments)" so the review surface is never
 *  blank). (Rendered as text → React auto-escapes; no sanitization needed for a DOM text node.) */
function identityValue(
  spec: ToolSpec | undefined,
  args: unknown,
  argsText: string | undefined
): string {
  const obj = asRecord(args) ?? (argsText ? safeParse(argsText) : null)
  if (spec && obj) {
    const v = obj[spec.field]
    if (typeof v === 'string' && v.trim().length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  if (obj && Object.keys(obj).length > 0) return JSON.stringify(obj)
  return ''
}

/** The continuation id to surface (notion_agent_chat's thread_id), or '' when the tool has no
 *  continuation field or the input doesn't carry one (a fresh conversation). */
function continuationValue(
  spec: ToolSpec | undefined,
  args: unknown,
  argsText: string | undefined
): string {
  if (!spec?.continuationField) return ''
  const obj = asRecord(args) ?? (argsText ? safeParse(argsText) : null)
  const v = obj?.[spec.continuationField]
  return typeof v === 'string' && v.trim().length > 0 ? v : ''
}

export function SimpleApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, argsText, respondToApproval } = props
  const { t } = useTranslation()
  const spec = SPECS[toolName]
  const phase = deriveCardPhase(props)
  const title = spec
    ? t(`chat.simpleApprovalCard.${spec.key}.title`)
    : t('chat.simpleApprovalCard.fallbackTitle')
  const value = identityValue(spec, args, argsText) || t('chat.simpleApprovalCard.noArgs')
  const continuation = continuationValue(spec, args, argsText)

  const onApprove = (): void => respondToApproval({ approved: true })
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={iconFor(toolName)} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {spec
              ? t(`chat.simpleApprovalCard.${spec.key}.label`)
              : t('chat.simpleApprovalCard.fallbackLabel')}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{value}</div>
          {continuation ? (
            <div className="mt-1.5 text-aux text-ink-fg-3">
              {t('chat.simpleApprovalCard.continuation', { id: continuation })}
            </div>
          ) : null}
          <ApprovalActions onApprove={onApprove} onReject={onReject} />
        </>
      ) : phase === 'rejected' || phase === 'expired' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg-2">{value}</div>
          <TerminalBanner phase={phase} />
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.simpleApprovalCard.error')}</div>
      ) : (
        // authorized (executing) / done — echo the pinned value; these tools' result bodies are
        // model-facing content (fenced web text / job id), not surfaced in the approval card.
        <div className="break-all font-mono text-meta text-ink-fg">{value}</div>
      )}
    </CardFrame>
  )
}
