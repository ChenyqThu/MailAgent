// task 06-08-chat Bug 2 — pure planner for interleaving chat tool-call chips
// into the assistant message body at their `content_offset`.
//
// Split out of MessageList.tsx so the time-ordering logic is unit-testable in a
// plain node env (no GSAP / Streamdown / IPC pulled in). The renderer maps the
// returned plan to elements 1:1, so asserting the plan == asserting the order.

import type { ChatToolCall } from '@shared/api/types'

/** One piece of the assembled assistant body: either a text slice (rendered
 *  through TranslatedBody) or a tool chip. `isLast` marks the final text slice
 *  so only it carries the streaming caret. */
export type AssistantSegment =
  | { kind: 'text'; text: string; isLast: boolean }
  | { kind: 'chip'; call: ChatToolCall }

/** Turn (content, tool calls) into a time-ordered segment list + the chips that
 *  couldn't be placed.
 *
 *  - Chips with a non-null `content_offset` split `content` at that offset
 *    ("text → chip → text → chip → … → tail text"). Offsets are clamped into
 *    [prev, content.length] so back-to-back chips and out-of-range offsets never
 *    produce negative/overlapping slices (harness offsets are already
 *    monotonic; this is defensive for hand-written/legacy data).
 *  - Empty text slices (a chip at offset 0, or two chips at the same offset) are
 *    dropped so we don't emit blank paragraphs.
 *  - Chips with a null offset (pre-v5 rows, or a mix where the harness didn't
 *    record one) go into `trailing` so the renderer can stack them below — they
 *    are never silently dropped.
 *
 *  Degrade: when NO chip is positioned, `segments` is a single text segment for
 *  the whole `content` (byte-identical to the pre-Bug-2 layout) and every chip
 *  is in `trailing`. */
export function planAssistantSegments(
  content: string,
  calls: ReadonlyArray<ChatToolCall>
): { segments: AssistantSegment[]; trailing: ChatToolCall[] } {
  const positioned: Array<{ call: ChatToolCall; offset: number }> = []
  const trailing: ChatToolCall[] = []
  let runningMin = 0
  for (const c of calls) {
    if (c.content_offset === null || c.content_offset === undefined) {
      trailing.push(c)
      continue
    }
    const clamped = Math.min(Math.max(c.content_offset, runningMin), content.length)
    runningMin = clamped
    positioned.push({ call: c, offset: clamped })
  }

  // No positioned chips → single text segment (legacy layout); all chips below.
  if (positioned.length === 0) {
    return {
      segments: [{ kind: 'text', text: content, isLast: true }],
      trailing
    }
  }

  const segments: AssistantSegment[] = []
  let cursor = 0
  for (const { call, offset } of positioned) {
    const slice = content.slice(cursor, offset)
    if (slice.length > 0) segments.push({ kind: 'text', text: slice, isLast: false })
    segments.push({ kind: 'chip', call })
    cursor = offset
  }
  const tail = content.slice(cursor)
  if (tail.length > 0) segments.push({ kind: 'text', text: tail, isLast: true })

  return { segments, trailing }
}
