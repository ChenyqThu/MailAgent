// harness-chat lane B — collapsible group for consecutive tool calls (assistant-ui ToolGroup slot).
//
// assistant-ui groups consecutive `tool-call` parts (even a single one) and renders them through
// this component with { startIndex, endIndex, children }; children are the already-rendered per-tool
// cards (A2UI by_name rich cards / ToolTraceCard fallback), untouched. We add a group header
// («N 个工具 · 运行中/完成/出错» + tool-name summary) and fold the детали away when settled — the
// same collapse paradigm as ReasoningText (markdown-text.tsx): the shared `CollapsibleRegion`
// primitive (grid-rows 0fr↔1fr pure-CSS height transition), duration-base + standard ease.
//
// Two 灾难级 red lines (each has a regression test):
//   ① endIndex === startIndex → render children BARE (a lone tool is a "group of one" in the
//      pipeline; grouping it would visually regress every single-tool turn).
//   ② a group containing an approval-requested OR errored tool is FORCE-EXPANDED and cannot be
//      collapsed — an approval card must never be hidden (no approve button = island-less deadlock).

import { useState, type PropsWithChildren } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { useAuiState } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { ShimmerText } from '@shared/components/ShimmerText'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { summarizeToolGroup } from './toolGroupSummary'

export function ToolGroupCard({
  startIndex,
  endIndex,
  children
}: PropsWithChildren<{ startIndex: number; endIndex: number }>): React.JSX.Element {
  const { t } = useTranslation()
  const parts = useAuiState((s) => s.message.parts) as readonly TurnStagePart[]

  const single = endIndex === startIndex
  const summary = summarizeToolGroup(single ? [] : parts.slice(startIndex, endIndex + 1))
  const done = summary.aggregate === 'done'
  const { forceExpand } = summary

  // Default: running groups expanded, an already-settled group (history replay) mounts collapsed.
  const [open, setOpen] = useState(!done)
  const [prevDone, setPrevDone] = useState(done)
  // Adjust-on-prop-change (react.dev): auto-collapse when the whole group settles, mirroring the
  // reasoning block. Never collapses a force-expanded group (shown stays true regardless of `open`).
  if (prevDone !== done) {
    setPrevDone(done)
    setOpen(!done)
  }
  const shown = forceExpand || open
  const canToggle = !forceExpand

  // Red line ① — a lone tool renders bare (no group chrome). Hooks above run unconditionally so
  // this early return keeps the hook order stable across single↔multi transitions.
  if (single) return <>{children}</>

  const running = summary.aggregate === 'running'
  const headerText = running
    ? t('chat.toolGroup.running')
    : summary.aggregate === 'awaiting'
      ? t('chat.toolGroup.awaiting')
      : summary.aggregate === 'error'
        ? t('chat.toolGroup.errored', { n: summary.count })
        : t('chat.toolGroup.using', { n: summary.count })
  const names = summary.toolNames.filter(Boolean).join(' · ')

  return (
    <div className="my-1.5 min-w-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-ink-2">
      <button
        type="button"
        onClick={() => {
          if (canToggle) setOpen((o) => !o)
        }}
        aria-expanded={shown}
        className={cn(
          'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors duration-fast',
          canToggle ? 'hover:bg-ink-3' : 'cursor-default'
        )}
      >
        {canToggle && (
          <ChevronRight
            size={13}
            className={cn(
              'shrink-0 text-ink-fg-3 transition-transform duration-fast',
              shown && 'rotate-90'
            )}
          />
        )}
        {running ? (
          <ShimmerText text={headerText} className="text-aux" />
        ) : (
          <span className="text-aux text-ink-fg-2">{headerText}</span>
        )}
        {names && (
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3" title={names}>
            {names}
          </span>
        )}
      </button>
      <CollapsibleRegion
        expanded={shown}
        bodyClassName="space-y-1.5 border-t border-[var(--hairline)] px-2.5 py-1.5"
      >
        {children}
      </CollapsibleRegion>
    </div>
  )
}
