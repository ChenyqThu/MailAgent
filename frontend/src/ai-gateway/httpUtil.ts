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

/** Read a request JSON body (64KB cap). Malformed / oversized → {} (callers validate the shape and
 *  answer E_INVALID_ARG so a bad body never throws). */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    let tooBig = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (tooBig) return
      body += chunk
      if (body.length > 65_536) {
        tooBig = true
        body = ''
      }
    })
    req.on('end', () => {
      if (tooBig || body.length === 0) return resolve({})
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
