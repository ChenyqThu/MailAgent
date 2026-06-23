// chat-panel P4 Phase 01 — generic tool-call trace card.
//
// The `tools.Fallback` slot for MessagePrimitive.Parts: every tool-call part
// (no per-tool UI is registered in Phase 01 — those land in phase-04 A2UI)
// renders through this card. It carries the 06-22 Phase 2 ① "tool timeline"
// requirement at baseline: tool name + kind icon + status (running / ok / error)
// + duration, with the request args + result JSON behind a progressive-
// disclosure toggle. MailAgent tokens only (ink-* surfaces, --c-accent accent),
// so it reskins across the theme three-state + 6 accents with zero edits.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
import { classifyTool, prettyJson, type ToolKind } from '@shared/components/chat/tool_steps'

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

/** Representative inline preview of the first non-empty string / number arg. */
function argPreview(args: unknown, argsText: string): string {
  const obj =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : safeParseObject(argsText)
  if (!obj) return ''
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.length > 48 ? `${v.slice(0, 48)}…` : v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'number') return String(v)
  }
  return ''
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
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
  isError
}: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const running = status?.type === 'running' || status?.type === 'requires-action'
  const err = isError === true || status?.type === 'incomplete'
  const kind = classifyTool(toolName)
  const preview = argPreview(args, argsText ?? '')
  const hasResult = result !== undefined && result !== null

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => {
          if (!running) setOpen((o) => !o)
        }}
        className="group flex w-full items-center gap-2.5 py-1 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink-1',
            TOOL_KIND_COLOR[kind]
          )}
        >
          {toolKindIconEl(kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
          {toolName}
          {preview && (
            <span className="ml-1.5 font-mono text-meta text-ink-fg-2" title={preview}>
              {preview}
            </span>
          )}
        </span>
        <span className="grid w-3.5 shrink-0 place-items-center">
          {running ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin text-coral" />
          ) : err ? (
            <X size={13} strokeWidth={2.5} className="text-fail" />
          ) : (
            <Check size={13} strokeWidth={2.5} className="text-ok" />
          )}
        </span>
        {!running && (
          <ChevronRight
            size={13}
            className={cn(
              'shrink-0 text-ink-fg-3 opacity-0 transition-transform duration-fast group-hover:opacity-100',
              open && 'rotate-90 opacity-100'
            )}
          />
        )}
      </button>

      {/* Progressive disclosure — request args + result JSON. display toggle. */}
      <div className={cn('ml-[29px]', open && !running ? 'block' : 'hidden')} aria-hidden={!open}>
        <div className="mb-1.5 rounded-lg border border-ink-border-soft bg-ink-1 px-2.5 py-2">
          <div className="mb-1 text-meta font-medium text-ink-fg-1">
            {t('chat.toolStep.request', { defaultValue: 'Request' })}
          </div>
          <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
            {argsText && argsText.trim() ? prettyJson(argsText) : prettyJson(args)}
          </pre>
        </div>
        {hasResult && (
          <div className="rounded-lg border border-ink-border-soft bg-ink-1 px-2.5 py-2">
            <div className="mb-1 text-meta font-medium text-ink-fg-1">
              {t('chat.toolStep.result', { defaultValue: 'Result' })}
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
