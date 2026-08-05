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
import { isSuggestFollowupsPart } from '@shared/assistant/followups'

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
  // W6 — `suggest_followups` 是「给 UI 供料」不是「用了个工具」：它零渲染（by_name →
  // SuggestFollowupsHiddenPart），组头却会把它算进「使用了 N 个工具 · …」并念出名字，说了一件
  // 用户在展开区里根本找不到的事。判据用 followups.ts 的单源 `isSuggestFollowupsPart`，不在这儿
  // 手抄一遍工具名（跨边界手抄常量的老规矩）。正常回合它与其它工具之间必隔着正文 → 本就不同组，
  // 这条只在模型抢跑（未按 prompt 等回答结束就调）时才起作用。
  const toolParts = parts.filter(
    (part) => part.type === 'tool-call' && !isSuggestFollowupsPart(part)
  )
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
