// chat-panel P4 Phase 05 — shared HTTP plumbing for the gateway endpoints.
//
// Extracted verbatim from server.ts so BOTH the canonical /api/ai/chat handler (server.ts) and the
// AG-UI mirror handler (agui/aguiRoute.ts) share one source — and so aguiRoute can reuse them
// WITHOUT importing server.ts (server.ts imports aguiRoute to register the route; the reverse would
// be a cycle). Pure node:http — no `ai` / electron / chat_db.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // loopback same-origin in production; opening CORS only eases harness/browser direct connection.
  // 🔴 Tighten Origin/loopback-token before any remote web surface (architecture §13.8.5/§13.11.6 —
  // batched with cutover 06); the AG-UI mirror inherits the same loopback-only trust model.
  'Access-Control-Allow-Origin': '*'
} as const

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const

/** Max request body size. Phase 06-parity raised this from 64KB: session reload sends the full
 *  message history alongside a ~12k email-body context snapshot, so a legit chat turn can exceed
 *  64KB and was silently becoming `{}` → a misleading "messages[] required" 400 (codex review). 8 MiB
 *  is ample for a long session + context and bounded for a loopback single-user gateway. */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024

/** Sentinel resolved by readJsonBody when the body exceeds MAX_JSON_BODY_BYTES, so chat handlers can
 *  answer an explicit 413 E_PAYLOAD_TOO_LARGE instead of a misleading 400. It is a frozen plain object
 *  so a caller that does NOT check (echo / approval — tiny bodies) just treats it as an empty body and
 *  fails its own shape validation, exactly as before. */
export const BODY_TOO_LARGE: Record<string, unknown> = Object.freeze({ __bodyTooLarge: true })

/** True when readJsonBody hit the size cap (reference-equality on the frozen sentinel). */
export function isBodyTooLarge(body: Record<string, unknown>): boolean {
  return body === BODY_TOO_LARGE
}

/** Read a request JSON body (MAX_JSON_BODY_BYTES cap). Malformed → {}; oversized → BODY_TOO_LARGE
 *  (chat handlers map it to 413, others treat it as {} and 400 on shape). A bad body never throws. */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    let tooBig = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (tooBig) return
      body += chunk
      if (body.length > MAX_JSON_BODY_BYTES) {
        tooBig = true
        body = ''
      }
    })
    req.on('end', () => {
      if (tooBig) return resolve(BODY_TOO_LARGE)
      if (body.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(body) as unknown
        resolve(
          typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
        )
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

export function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
