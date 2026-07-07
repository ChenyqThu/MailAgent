// 1.5.0 dogfood (task 07-07) — SimpleApprovalCard: the identity-only edit-tier approval card shared
// by the four tools whose approval needs NO field editor, just approve / reject over a pinned
// identity value:
//   web_fetch (URL) · web_search (query) · custom_agent_delete (agent id) · custom_agent_run_now.
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

import { Globe, Play, Search, Trash2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'

/** Per-tool copy: header title, the pending lead-in label, and which model-input field carries the
 *  pinned identity value the user reviews. (Icons live in `iconFor` — a render-time function, not a
 *  module-scope JSX const, mirroring ExecApprovalCard / ToolTraceCard.) */
interface ToolSpec {
  title: string
  label: string
  field: string
}

const SPECS: Record<string, ToolSpec> = {
  web_fetch: {
    title: '联网抓取网页',
    label: '将联网抓取以下网页（需你批准）：',
    field: 'url'
  },
  web_search: {
    title: '联网搜索',
    label: '将用以下关键词联网搜索（需你批准）：',
    field: 'query'
  },
  custom_agent_delete: {
    title: '删除 Custom Agent',
    label: '将删除以下 Custom Agent（删除后不可恢复，需你批准）：',
    field: 'agent_id'
  },
  custom_agent_run_now: {
    title: '立即运行 Custom Agent',
    label: '将立即运行以下 Custom Agent（需你批准）：',
    field: 'agent_id'
  }
}

function iconFor(toolName: string): React.ReactNode {
  if (toolName === 'web_search') return <Search size={13} strokeWidth={2} />
  if (toolName === 'custom_agent_delete') return <Trash2 size={13} strokeWidth={2} />
  if (toolName === 'custom_agent_run_now') return <Play size={13} strokeWidth={2} />
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
 *  compact JSON summary of the args when the expected field is absent, and to '(无参数)' when there
 *  is nothing — so the review surface is never blank. (Rendered as text → React auto-escapes; no
 *  sanitization needed for a DOM text node.) */
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
  return '(无参数)'
}

export function SimpleApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, argsText, respondToApproval } = props
  const spec = SPECS[toolName]
  const phase = deriveCardPhase(props)
  const title = spec?.title ?? '操作确认'
  const value = identityValue(spec, args, argsText)

  const onApprove = (): void => respondToApproval({ approved: true })
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame icon={iconFor(toolName)} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {spec?.label ?? '将执行以下操作，需你批准：'}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{value}</div>
          <ApprovalActions onApprove={onApprove} onReject={onReject} approveLabel="允许" />
        </>
      ) : phase === 'rejected' || phase === 'expired' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg-2">{value}</div>
          <TerminalBanner phase={phase} />
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">操作失败，请重试或让助手重新发起。</div>
      ) : (
        // authorized (executing) / done — echo the pinned value; these tools' result bodies are
        // model-facing content (fenced web text / job id), not surfaced in the approval card.
        <div className="break-all font-mono text-meta text-ink-fg">{value}</div>
      )}
    </CardFrame>
  )
}
