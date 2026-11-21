import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { MessagePrimitive, useAuiState } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { ShimmerText } from '@shared/components/ShimmerText'
import { deriveToolPhase, isToolPhaseSettled } from '@shared/assistant/runtime/toolPhase'
import { extractReasoningHeading } from '@shared/assistant/runtime/reasoningSummary'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { narrateToolCall, summarizeToolActions } from '@shared/assistant/tools/toolNarration'
import { formatToolDuration, useToolElapsed } from './useToolElapsed'

const MAX_LIVE_VISIBLE_STEPS = 3

/** Leaf timer isolating 100ms clock ticks from the timeline container. */
function TurnProcessElapsed({
  live,
  title
}: {
  live: boolean
  title: string
}): React.JSX.Element | null {
  const elapsed = useToolElapsed(live)
  if (elapsed === null) return null
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3" title={title}>
      {formatToolDuration(elapsed)}
    </span>
  )
}

function isPartRunning(part: TurnStagePart): boolean {
  if (part.type === 'reasoning') return part.status?.type === 'running'
  if (part.type === 'tool-call') return !isToolPhaseSettled(deriveToolPhase(part))
  return false
}

export interface TurnProcessGroupProps {
  readonly foldableIndices: readonly number[]
  readonly hasFollowingContent: boolean
  readonly partComponents: React.ComponentProps<typeof MessagePrimitive.Parts>['components']
}

/**
 * Unified pre-answer process timeline combining interleaved reasoning blocks and silent read/search
 * tools into one calm collapsible container. Expands while active (capped to latest 3 steps by
 * default) and auto-collapses to a concise 1-line summary once final prose starts or the turn ends.
 */
export function TurnProcessGroup({
  foldableIndices,
  hasFollowingContent,
  partComponents
}: TurnProcessGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const contentId = useId()
  const parts = useAuiState((s) => s.message.parts) as readonly TurnStagePart[]
  const msgStatusType = useAuiState((s) => s.message.status?.type)

  const groupParts = useMemo(
    () =>
      foldableIndices
        .map((idx) => parts[idx])
        .filter((part): part is TurnStagePart => part !== undefined),
    [foldableIndices, parts]
  )

  const hasLivePart = groupParts.some(isPartRunning)
  const running = hasLivePart || (msgStatusType === 'running' && !hasFollowingContent)
  const settled = !running

  const [open, setOpen] = useState(!settled)
  const [prevSettled, setPrevSettled] = useState(settled)
  if (prevSettled !== settled) {
    setPrevSettled(settled)
    setOpen(!settled)
  }

  const [showAllLive, setShowAllLive] = useState(false)

  const liveSummary = useMemo(() => {
    for (let i = groupParts.length - 1; i >= 0; i -= 1) {
      const part = groupParts[i]
      if (!part) continue
      if (part.type === 'tool-call' && isPartRunning(part) && part.toolName) {
        return narrateToolCall(
          { toolName: part.toolName, args: part.args, argsText: part.argsText },
          t
        )
      }
      if (part.type === 'reasoning' && part.status?.type === 'running') {
        const heading = extractReasoningHeading(part.text)
        if (heading) return t('chat.turnNarration.thinkingHeading', { heading })
      }
    }
    return t('chat.processTimeline.running')
  }, [groupParts, t])

  const settledSummary = useMemo(() => {
    const base = t('chat.processTimeline.settledSummary', { count: foldableIndices.length })
    const tools = summarizeToolActions(groupParts, t)
    return tools ? `${base} · ${tools}` : base
  }, [foldableIndices.length, groupParts, t])

  const hideOlderLiveSteps =
    running && foldableIndices.length > MAX_LIVE_VISIBLE_STEPS && !showAllLive
  const visibleIndices = useMemo(
    () =>
      hideOlderLiveSteps ? foldableIndices.slice(-MAX_LIVE_VISIBLE_STEPS) : foldableIndices,
    [foldableIndices, hideOlderLiveSteps]
  )

  return (
    <div
      data-testid="turn-process-group"
      className="my-1.5 min-w-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-ink-2"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-fast hover:bg-ink-3"
      >
        <ChevronRight
          size={13}
          className={cn(
            'shrink-0 text-ink-fg-3 transition-transform duration-fast',
            open && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1 truncate text-aux">
          {running ? (
            <ShimmerText text={liveSummary} className="text-aux" />
          ) : (
            <span className="text-aux text-ink-fg-2" title={settledSummary}>
              {settledSummary}
            </span>
          )}
        </span>
        <TurnProcessElapsed live={running} title={t('chat.toolStep.duration')} />
      </button>

      <CollapsibleRegion
        expanded={open}
        id={contentId}
        bodyClassName="space-y-1 border-t border-[var(--hairline)] px-2.5 py-1.5"
      >
        {hideOlderLiveSteps && (
          <button
            type="button"
            onClick={() => setShowAllLive(true)}
            className="mb-1 text-aux text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-1"
          >
            {t('chat.processTimeline.showAllSteps', { count: foldableIndices.length })}
          </button>
        )}
        {visibleIndices.map((idx) => (
          <MessagePrimitive.PartByIndex key={`proc-${idx}`} index={idx} components={partComponents} />
        ))}
      </CollapsibleRegion>
    </div>
  )
}
