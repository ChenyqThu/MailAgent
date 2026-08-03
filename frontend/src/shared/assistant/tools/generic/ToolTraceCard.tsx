// chat-panel P4 Phase 01 — generic tool-call trace card.
//
// The `tools.Fallback` slot for MessagePrimitive.Parts: every tool-call part with no rich
// by_name card renders through this one (registry miss never blocks). It is mounted on all three
// chat surfaces — email panel (components/message.tsx), agent panel / Cmd+O
// (components/agents/AgentMessage.tsx) and the read-only history transcript
// (ReadOnlyTranscript.tsx) — so every state below must also be correct for a REPLAYED part that
// only ever had a result.
//
// 阶段 0.5-① 「工具执行过程可见」 — the card is now the four-段 surface:
//   ① 流式参数  the disclosure opens WHILE the call runs and re-renders as `args` fills in
//              (it used to be `hidden` + the toggle disabled until the tool finished);
//   ② 加载占位  an `animate-pulse` skeleton stands in for arguments that have not arrived;
//   ③ 标题行    kind icon + human-readable localized title + arg preview + LIVE elapsed + status;
//   ④ 最终结果  the request / result JSON, plus a row-level ok / error / denied distinction.
// State comes from ONE judge (`runtime/toolPhase.ts`), elapsed from the renderer clock
// (`useToolElapsed` — the runtime's `part.timing` is never populated by our gateway).
// MailAgent tokens only (ink-* surfaces, --c-accent accent), so it reskins across the theme
// three-state + 6 accents with zero edits.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  Check,
  CheckSquare,
  ChevronRight,
  FileText,
  Flag,
  Link2,
  Loader2,
  Search,
  Terminal,
  X
} from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import {
  classifyTool,
  prettyJson,
  toolTitleKey,
  type ToolKind
} from '@shared/components/chat/tool_steps'
import {
  deriveToolPhase,
  isToolDenied,
  isToolPhaseSettled
} from '@shared/assistant/runtime/toolPhase'
import { formatToolDuration, useToolElapsed } from './useToolElapsed'

/** ToolKind → lucide icon (fixed set, not a render-time factory — matches the
 *  legacy toolKindIconEl constraint that avoids react-hooks/static-components). */
function toolKindIconEl(kind: ToolKind, size = 13): React.ReactElement {
  switch (kind) {
    case 'read':
      return <FileText size={size} strokeWidth={2} />
    case 'task':
      return <CheckSquare size={size} strokeWidth={2} />
    case 'write':
      return <Flag size={size} strokeWidth={2} />
    case 'cmd':
      return <Terminal size={size} strokeWidth={2} />
    case 'link':
      return <Link2 size={size} strokeWidth={2} />
    case 'search':
    default:
      return <Search size={size} strokeWidth={2} />
  }
}

const TOOL_KIND_COLOR: Record<ToolKind, string> = {
  search: 'text-ink-fg-1',
  read: 'text-info',
  task: 'text-coral',
  write: 'text-coral',
  cmd: 'text-ai',
  link: 'text-ok'
}

/** G6 — the row-level outcome. `denied` (the user refused the call) is deliberately separate from
 *  `error` (the tool ran and failed): they look the same in the raw part (both carry isError +
 *  an `{error}` result) but mean opposite things to the reader. */
type RowTone = 'live' | 'ok' | 'error' | 'denied'

const TONE_CHIP: Record<RowTone, string> = {
  live: 'bg-ink-1',
  ok: 'bg-ink-1',
  error: 'bg-fail/10 text-fail',
  denied: 'bg-ink-3 text-ink-fg-3'
}

const TONE_STATUS_KEY: Record<RowTone, string> = {
  live: 'chat.toolStep.statusRunning',
  ok: 'chat.toolStep.statusOk',
  error: 'chat.toolStep.statusError',
  denied: 'chat.toolStep.statusDenied'
}

function statusIconEl(tone: RowTone): React.ReactElement {
  switch (tone) {
    case 'live':
      return <Loader2 size={13} strokeWidth={2} className="animate-spin text-coral" />
    case 'error':
      return <X size={13} strokeWidth={2.5} className="text-fail" />
    case 'denied':
      return <Ban size={13} strokeWidth={2} className="text-ink-fg-3" />
    case 'ok':
    default:
      return <Check size={13} strokeWidth={2.5} className="text-ok" />
  }
}

/** Representative inline preview of the first non-empty string / number arg. Reads `args` (the
 *  partial-parsed object) first so it grows field by field while the model streams. */
function argPreview(args: unknown, argsText: string): string {
  const obj = asPlainObject(args) ?? safeParseObject(argsText)
  if (!obj) return ''
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.length > 48 ? `${v.slice(0, 48)}…` : v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'number') return String(v)
  }
  return ''
}

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    return asPlainObject(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

export function ToolTraceCard({
  toolName,
  args,
  argsText,
  result,
  status,
  isError,
  approval
}: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const part = { argsText, result, isError, approval, status }
  const phase = deriveToolPhase(part)
  const settled = isToolPhaseSettled(phase)
  const elapsed = useToolElapsed(!settled)

  const tone: RowTone = !settled
    ? 'live'
    : isToolDenied(part)
      ? 'denied'
      : phase === 'error'
        ? 'error'
        : 'ok'
  const kind = classifyTool(toolName)
  const titleKey = toolTitleKey(toolName)
  const title = titleKey === null ? toolName : t(titleKey)
  const text = argsText ?? ''
  const preview = argPreview(args, text)
  const argsObject = asPlainObject(args)
  const hasArgs = argsObject !== null && Object.keys(argsObject).length > 0
  const hasResult = result !== undefined && result !== null

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2.5 py-1 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-md',
            TONE_CHIP[tone],
            tone === 'live' || tone === 'ok' ? TOOL_KIND_COLOR[kind] : undefined
          )}
        >
          {toolKindIconEl(kind)}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-aux',
            tone === 'denied' ? 'text-ink-fg-3' : 'text-ink-fg'
          )}
        >
          {title}
          {preview ? (
            <span className="ml-1.5 font-mono text-meta text-ink-fg-2" title={preview}>
              {preview}
            </span>
          ) : phase === 'streaming-args' ? (
            // ② 加载占位 — the arguments are still arriving. Block-level `animate-pulse` skeleton
            // (motion-gsap.md §9 loading 三词汇), NOT a second spinner / shimmer on this row.
            <span
              className="ml-1.5 inline-block h-2.5 w-20 animate-pulse rounded bg-ink-3 align-middle motion-reduce:animate-none"
              aria-label={t('chat.toolStep.argsStreaming')}
            />
          ) : null}
        </span>
        {elapsed !== null && (
          <span
            className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3"
            title={t('chat.toolStep.duration')}
          >
            {formatToolDuration(elapsed)}
          </span>
        )}
        <span
          className="grid w-3.5 shrink-0 place-items-center"
          role="img"
          aria-label={t(TONE_STATUS_KEY[tone])}
        >
          {statusIconEl(tone)}
        </span>
        <ChevronRight
          size={13}
          className={cn(
            'shrink-0 text-ink-fg-3 opacity-0 transition-transform duration-fast group-hover:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </button>

      {/* ①/④ Progressive disclosure — request args + result JSON. Open WHILE running too, so the
          arguments can be watched as they stream in. display toggle. */}
      <div className={cn('ml-[29px]', open ? 'block' : 'hidden')} aria-hidden={!open}>
        <div className="mb-1.5 rounded-lg border border-ink-border-soft bg-ink-1 px-2.5 py-2">
          <div className="mb-1 text-meta font-medium text-ink-fg-1">
            {t('chat.toolStep.request')}
          </div>
          {hasArgs ? (
            // R6 — `args` is the partial-JSON PARSE of the stream, so it is always well-formed;
            // `argsText` is a truncated prefix mid-stream and only serves as a fallback.
            <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {prettyJson(argsObject)}
            </pre>
          ) : phase === 'streaming-args' ? (
            <div
              className="animate-pulse space-y-1.5 motion-reduce:animate-none"
              aria-label={t('chat.toolStep.argsStreaming')}
            >
              <div className="h-2.5 w-2/3 rounded bg-ink-3" />
              <div className="h-2.5 w-1/3 rounded bg-ink-3" />
            </div>
          ) : (
            <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {text.trim() ? prettyJson(text) : prettyJson(args)}
            </pre>
          )}
        </div>
        {hasResult && (
          <div className="rounded-lg border border-ink-border-soft bg-ink-1 px-2.5 py-2">
            <div className="mb-1 text-meta font-medium text-ink-fg-1">
              {t('chat.toolStep.result')}
            </div>
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {prettyJson(result)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
