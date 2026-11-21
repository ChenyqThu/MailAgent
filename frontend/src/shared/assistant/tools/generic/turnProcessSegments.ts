import { isSuggestFollowupsPart } from '@shared/assistant/followups'
import { PLAN_UPDATE_TOOL_NAME } from '@shared/assistant/plan'
import { deriveToolPhase, partAwaitsApproval } from '@shared/assistant/runtime/toolPhase'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { componentRegistry } from '../ComponentRegistry'

/** Canonical set of tool names that render dedicated rich A2UI / action cards (never folded into
 *  a silent process timeline so interactive write receipts, drafts, and plans remain prominent). */
export const RICH_CARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(componentRegistry.byName),
  PLAN_UPDATE_TOOL_NAME
])

export type AssistantPartSegment =
  | { readonly kind: 'single'; readonly index: number }
  | {
      readonly kind: 'process'
      readonly key: string
      readonly foldableIndices: readonly number[]
      readonly hasFollowingContent: boolean
    }

/** Structural parts that produce no independent content bubble and can sit between foldable
 *  reasoning/read steps inside a single agentic phase. */
export function isTransparentBridgePart(part: TurnStagePart): boolean {
  if (part.type === 'step-start') return true
  if (part.type === 'data' || part.type.startsWith('data-')) return true
  if (part.type === 'text') {
    return typeof part.text !== 'string' || part.text.trim().length === 0
  }
  return false
}

/** True if this part belongs inside a unified pre-answer process timeline. Never folds visible
 *  errors, pending approvals, or registered A2UI write/artifact/plan cards. */
export function isFoldableProcessPart(
  part: TurnStagePart,
  richCardNames: ReadonlySet<string> = RICH_CARD_TOOL_NAMES
): boolean {
  if (part.type === 'reasoning') {
    const hasText = typeof part.text === 'string' && part.text.trim().length > 0
    return hasText || part.status?.type === 'running'
  }
  if (part.type === 'tool-call') {
    if (isSuggestFollowupsPart(part)) return false
    const toolName = part.toolName ?? ''
    if (richCardNames.has(toolName)) return false
    if (partAwaitsApproval(part)) return false
    if (deriveToolPhase(part) === 'error') return false
    return true
  }
  return false
}

function isSubstantiveFollowupPart(part: TurnStagePart): boolean {
  return !isTransparentBridgePart(part) && !isSuggestFollowupsPart(part)
}

/**
 * Segment an assistant message's ordered parts into unified `process` timeline blocks and
 * top-level `single` parts (prose answers, rich A2UI cards, errors, approvals).
 */
export function segmentAssistantParts(
  parts: readonly TurnStagePart[],
  richCardNames: ReadonlySet<string> = RICH_CARD_TOOL_NAMES
): AssistantPartSegment[] {
  const segments: AssistantPartSegment[] = []
  let i = 0

  while (i < parts.length) {
    const part = parts[i]
    if (!part || !isFoldableProcessPart(part, richCardNames)) {
      segments.push({ kind: 'single', index: i })
      i += 1
      continue
    }

    const foldableIndices: number[] = [i]
    let lastFoldable = i
    let j = i + 1

    while (j < parts.length) {
      const next = parts[j]
      if (!next) break
      if (isFoldableProcessPart(next, richCardNames)) {
        foldableIndices.push(j)
        lastFoldable = j
        j += 1
        continue
      }
      if (isTransparentBridgePart(next)) {
        j += 1
        continue
      }
      break
    }

    let hasFollowingContent = false
    for (let k = lastFoldable + 1; k < parts.length; k += 1) {
      const after = parts[k]
      if (after && isSubstantiveFollowupPart(after)) {
        hasFollowingContent = true
        break
      }
    }

    const firstPart = parts[foldableIndices[0]!]
    const shouldGroup =
      foldableIndices.length >= 2 ||
      (foldableIndices.length === 1 && firstPart?.type === 'tool-call' && hasFollowingContent)

    if (shouldGroup) {
      segments.push({
        kind: 'process',
        key: `process-${foldableIndices[0]}`,
        foldableIndices,
        hasFollowingContent
      })
      i = lastFoldable + 1
    } else {
      segments.push({ kind: 'single', index: i })
      i += 1
    }
  }

  return segments
}
