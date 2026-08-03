// harness-chat lane B — pure aggregation of a consecutive tool-call group.
//
// assistant-ui groups consecutive `tool-call` parts into one range (even a single call) and
// hands the ToolGroup component only { startIndex, endIndex, children }. To render a group
// header + drive the collapse/force-expand policy we summarize the underlying parts here, as a
// pure function so the two灾难级 red lines are unit-tested without a runtime:
//   ① a single tool renders bare (the caller special-cases count === 1);
//   ② a group containing an approval-requested OR errored tool must NEVER fold that part away.

import { deriveToolPhase } from '@shared/assistant/runtime/toolPhase'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'

export type ToolGroupAggregate = 'running' | 'awaiting' | 'error' | 'done'

export interface ToolGroupSummary {
  readonly count: number
  readonly aggregate: ToolGroupAggregate
  /** Red line ②: true when the group must stay expanded (an approval card or an error must
   *  never be hidden by a collapse). */
  readonly forceExpand: boolean
  readonly toolNames: readonly string[]
}

type ToolPartState = 'awaiting' | 'error' | 'done' | 'running'

/** Group-level projection of the shared `deriveToolPhase` (阶段 0.5-①): the card's two live
 *  phases (`streaming-args` / `executing`) collapse back into the one bucket a GROUP header cares
 *  about. 🔴 `awaiting` / `error` must stay byte-for-byte what they were — red line ② (never fold
 *  an approval or an error away) is defined on them; `toolPhase.test.ts` pins the equivalence
 *  against a verbatim copy of the pre-refactor judgement. */
function toolPartState(part: TurnStagePart): ToolPartState {
  const phase = deriveToolPhase(part)
  return phase === 'streaming-args' || phase === 'executing' ? 'running' : phase
}

export function summarizeToolGroup(parts: readonly TurnStagePart[]): ToolGroupSummary {
  const toolParts = parts.filter((part) => part.type === 'tool-call')
  const states = toolParts.map(toolPartState)
  const hasAwaiting = states.includes('awaiting')
  const hasError = states.includes('error')
  const hasRunning = states.includes('running')
  // Header priority: an unresolved approval is the most actionable state, then error, then live
  // work, else fully settled. forceExpand is orthogonal (both approval and error pin it open).
  const aggregate: ToolGroupAggregate = hasAwaiting
    ? 'awaiting'
    : hasError
      ? 'error'
      : hasRunning
        ? 'running'
        : 'done'
  return {
    count: toolParts.length,
    aggregate,
    forceExpand: hasAwaiting || hasError,
    toolNames: toolParts.map((part) => part.toolName ?? '')
  }
}
