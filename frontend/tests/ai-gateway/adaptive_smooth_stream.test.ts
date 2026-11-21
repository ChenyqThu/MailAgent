import { describe, expect, test } from 'vitest'

import {
  ADAPTIVE_STREAM_FAST_DELAY_MS,
  adaptiveSmoothStream
} from '../../src/ai-gateway/adaptiveSmoothStream'
import { STREAM_CHUNKING_REGEX } from '../../src/ai-gateway/chatRun'

interface RecordedDelay {
  ms: number
}

async function runStream(
  chunks: Array<Record<string, unknown>>,
  opts?: { fastThreshold?: number; instantThreshold?: number; baseDelayMs?: number }
): Promise<{ emitted: Array<Record<string, unknown>>; delays: RecordedDelay[] }> {
  const delays: RecordedDelay[] = []
  const transform = adaptiveSmoothStream({
    chunking: STREAM_CHUNKING_REGEX,
    baseDelayMs: opts?.baseDelayMs ?? 7,
    fastThreshold: opts?.fastThreshold ?? 40,
    instantThreshold: opts?.instantThreshold ?? 150,
    _internal: {
      delay: async (ms: number) => {
        delays.push({ ms })
      }
    }
  })({ tools: {}, stopStream: () => {} })

  const emitted: Array<Record<string, unknown>> = []
  const pipe = transform.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        emitted.push(chunk as unknown as Record<string, unknown>)
      }
    })
  )

  const writer = transform.writable.getWriter()
  for (const chunk of chunks) {
    await writer.write(chunk as never)
  }
  await writer.close()
  await pipe
  return { emitted, delays }
}

describe('adaptiveSmoothStream', () => {
  test('passes reasoning-delta and tool parts through with 0ms delay', async () => {
    const { emitted, delays } = await runStream(
      [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', text: '正在检索最近十封邮件并比对日期…' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'tool-input-start', id: 'tc1', toolName: 'email_search_fulltext' },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'email_search_fulltext', input: '{}' }
      ],
      { baseDelayMs: 50 }
    )

    expect(delays).toHaveLength(0)
    expect(emitted.map((c) => c.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'tool-input-start',
      'tool-call'
    ])
  })

  test('flushes buffered trailing text immediately before a non-text chunk', async () => {
    const { emitted } = await runStream([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'pending' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'email_get', input: '{}' }
    ])

    expect(emitted.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'tool-call'])
    expect(emitted[1]?.text).toBe('pending')
  })

  test('compresses delay at medium backlog and drops to 0ms catch-up above instantThreshold', async () => {
    const longEnglish = Array.from({ length: 45 }, (_, i) => `word${i} `).join('')
    const { emitted, delays } = await runStream(
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', text: longEnglish },
        { type: 'text-end', id: 't1' }
      ],
      { baseDelayMs: 7, fastThreshold: 30, instantThreshold: 80 }
    )

    const reconstructed = emitted
      .filter((c) => c.type === 'text-delta')
      .map((c) => String(c.text))
      .join('')
    expect(reconstructed).toBe(longEnglish)

    // Initial high backlog skips waiting altogether (0ms catch-up), then steps down to fastDelayMs
    // and finally baseDelayMs for the last trailing tokens.
    expect(delays.some((d) => d.ms === ADAPTIVE_STREAM_FAST_DELAY_MS)).toBe(true)
    expect(delays.some((d) => d.ms === 7)).toBe(true)
    expect(delays.length).toBeLessThan(20)
  })
})
