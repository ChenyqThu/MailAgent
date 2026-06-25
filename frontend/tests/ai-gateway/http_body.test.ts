// chat-panel P4 Phase 06-parity (codex review) — readJsonBody size cap + 413 sentinel.
//
// Session reload sends the full message history alongside a ~12k context snapshot, so the gateway's
// old 64KB cap silently turned a legit turn into `{}` → a misleading "messages[] required" 400. The
// cap is now 8 MiB and an oversized body resolves the BODY_TOO_LARGE sentinel so chat handlers answer
// an explicit 413. These tests pin the parser contract (the handler 413 wiring is covered by reading
// the same sentinel).

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import type { IncomingMessage } from 'node:http'

import {
  BODY_TOO_LARGE,
  MAX_JSON_BODY_BYTES,
  isBodyTooLarge,
  readJsonBody
} from '../../src/ai-gateway/httpUtil'

/** Minimal IncomingMessage mock that emits `chunks` then `end`. */
function mockReq(chunks: string[]): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void }
  req.setEncoding = () => {}
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', c)
    req.emit('end')
  })
  return req as unknown as IncomingMessage
}

describe('readJsonBody size cap', () => {
  test('parses a normal JSON body', async () => {
    const body = await readJsonBody(mockReq([JSON.stringify({ sessionId: 7, messages: [] })]))
    expect(body).toEqual({ sessionId: 7, messages: [] })
    expect(isBodyTooLarge(body)).toBe(false)
  })

  test('parses a multi-chunk body well under the cap', async () => {
    const big = 'x'.repeat(200_000)
    const body = await readJsonBody(mockReq([`{"a":"`, big, `"}`]))
    expect((body as { a: string }).a.length).toBe(200_000)
    expect(isBodyTooLarge(body)).toBe(false)
  })

  test('a body over the cap resolves the BODY_TOO_LARGE sentinel', async () => {
    const over = 'x'.repeat(MAX_JSON_BODY_BYTES + 1)
    const body = await readJsonBody(mockReq([over]))
    expect(isBodyTooLarge(body)).toBe(true)
    expect(body).toBe(BODY_TOO_LARGE)
  })

  test('malformed JSON → {} (not the too-large sentinel)', async () => {
    const body = await readJsonBody(mockReq(['{not json']))
    expect(body).toEqual({})
    expect(isBodyTooLarge(body)).toBe(false)
  })

  test('isBodyTooLarge is false for a plain object', () => {
    expect(isBodyTooLarge({})).toBe(false)
    expect(isBodyTooLarge({ __bodyTooLarge: true })).toBe(false) // a look-alike, not the sentinel ref
  })
})
