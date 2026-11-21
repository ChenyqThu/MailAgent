import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai'

export const ADAPTIVE_STREAM_FAST_THRESHOLD = 40
export const ADAPTIVE_STREAM_INSTANT_THRESHOLD = 150
export const ADAPTIVE_STREAM_FAST_DELAY_MS = 2
const DEFAULT_BASE_DELAY_MS = 7

export interface AdaptiveSmoothStreamOptions {
  /** RegExp defining token emission boundaries for text-delta smoothing. */
  chunking?: RegExp
  /** Delay between chunks when buffered backlog is low (<= fastThreshold). */
  baseDelayMs?: number
  /** Backlog char count above which delay drops to fastDelayMs. */
  fastThreshold?: number
  /** Backlog char count above which delay drops to 0ms to catch up immediately. */
  instantThreshold?: number
  /** Reduced delay used when backlog is between fastThreshold and instantThreshold. */
  fastDelayMs?: number
  /** Test seam mirroring ai SDK smoothStream._internal.delay. */
  _internal?: {
    delay?: (delayInMs: number) => Promise<void>
  }
}

const DEFAULT_DELAY = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Adaptive stream smoother:
 * - Non-text parts (reasoning-delta, tool-input-*, tool-call, tool-result, lifecycle events) flush
 *   any buffered text immediately and pass through at 0ms so thinking & tool UI stays instantaneous.
 * - Text deltas use backlog-aware pacing: steady baseDelayMs at normal speeds, compressing to
 *   fastDelayMs and 0ms catch-up when tokens arrive faster than display cadence.
 */
export function adaptiveSmoothStream<TOOLS extends ToolSet>(
  opts: AdaptiveSmoothStreamOptions = {}
): StreamTextTransform<TOOLS> {
  const rawRegex = opts.chunking ?? /[一-\u9fff]|\S+\s+/
  // Normalize off any /g flag so RegExp.prototype.exec always inspects from index 0 deterministically.
  const regex = new RegExp(rawRegex.source, rawRegex.flags.replace('g', ''))
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const fastThreshold = opts.fastThreshold ?? ADAPTIVE_STREAM_FAST_THRESHOLD
  const instantThreshold = opts.instantThreshold ?? ADAPTIVE_STREAM_INSTANT_THRESHOLD
  const fastDelayMs = opts.fastDelayMs ?? ADAPTIVE_STREAM_FAST_DELAY_MS
  const wait = opts._internal?.delay ?? DEFAULT_DELAY

  const pickDelay = (remainingLength: number): number => {
    if (remainingLength > instantThreshold) return 0
    if (remainingLength > fastThreshold) return fastDelayMs
    return baseDelayMs
  }

  return () => {
    let buffer = ''
    let bufferId = ''

    const flushAll = (controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>): void => {
      if (buffer.length === 0) return
      controller.enqueue({
        type: 'text-delta',
        id: bufferId,
        text: buffer
      } as TextStreamPart<TOOLS>)
      buffer = ''
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      async transform(chunk, controller) {
        if (chunk.type !== 'text-delta') {
          flushAll(controller)
          controller.enqueue(chunk)
          return
        }

        if (chunk.id !== bufferId) {
          flushAll(controller)
          bufferId = chunk.id
        }

        buffer += chunk.text

        for (;;) {
          const match = regex.exec(buffer)
          if (!match) {
            if (buffer.length > instantThreshold) {
              flushAll(controller)
            }
            break
          }

          const end = match.index + match[0].length
          if (end === 0) break

          const piece = buffer.slice(0, end)
          buffer = buffer.slice(end)
          controller.enqueue({
            type: 'text-delta',
            id: bufferId,
            text: piece
          } as TextStreamPart<TOOLS>)

          if (buffer.length > 0) {
            const delayMs = pickDelay(buffer.length)
            if (delayMs > 0) {
              await wait(delayMs)
            }
          }
        }
      },

      flush(controller) {
        flushAll(controller)
      }
    })
  }
}
