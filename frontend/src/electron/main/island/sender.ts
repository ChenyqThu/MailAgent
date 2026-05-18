// Sprint 9 §2.1 — Island unix socket sender.
//
// Implements the wire protocol from ISLAND-PLUGIN.md §3.1:
//   AF_UNIX SOCK_STREAM
//   connect → write(<utf-8 JSON envelope>) → shutdown(SHUT_WR)
//   → read until EOF → close
//
// Hard limits per the spec:
//   envelope <= 64 KiB (we throw ProtocolError above this; caller should not
//                       have built such an envelope in the first place — the
//                       builders clip metadata fields so this is defensive)
//   response <= 1 MiB  (we destroy the socket if the response keeps growing;
//                       ping-island is well-behaved but a malformed peer
//                       could DoS the main process otherwise)
//   timeout  =  3 s   (shared deadline across connect/write/recv — defaults
//                      to ISLAND_SOCKET_TIMEOUT env var)
//
// fail-open philosophy: ping-island not installed / not running / sleeping /
// socket replaced / response malformed — all silently swallowed so the AI
// Chat flow that triggered the envelope never blocks waiting on the island.
// The caller gets `null` back; status updates flow through `probe.ts` instead.

import net from 'net'

import type { BridgeEnvelope } from './envelope'
import { serializeEnvelope } from './envelope'

/** ISLAND-PLUGIN §3.1 wire bounds. */
const MAX_ENVELOPE_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_SOCKET_PATH = '/tmp/island.sock'

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Outcome of a single `sendEnvelope` call. The renderer doesn't see this
 *  shape — the IPC handler maps it onto `IslandStatus.state` (see
 *  `handlers/island.ts`). */
export type SendOutcome =
  | { ok: true; response: unknown | null }
  | {
      ok: false
      /** Coarse failure bucket. Drives the status state machine. */
      reason:
        | 'enoent' // socket file missing → ping-island not running
        | 'refused' // ECONNREFUSED → ping-island crashed / restarting
        | 'timeout' // shared deadline hit
        | 'protocol' // envelope too big / response too big / parse fail
        | 'unknown' // anything else
      detail: string
    }

export interface SendOpts {
  socketPath?: string
  timeoutMs?: number
}

export function resolveSocketPath(opts?: SendOpts): string {
  return opts?.socketPath ?? process.env.ISLAND_SOCKET_PATH ?? DEFAULT_SOCKET_PATH
}

export function resolveTimeoutMs(opts?: SendOpts): number {
  const fromOpts = opts?.timeoutMs
  if (typeof fromOpts === 'number' && Number.isFinite(fromOpts)) return fromOpts
  // Reviewer L4: env is now interpreted in milliseconds to match the
  // `_MS` constant suffix and the default value `3_000`. `ISLAND_SOCKET_TIMEOUT_MS`
  // is the canonical name; `ISLAND_SOCKET_TIMEOUT` is kept as an alias for
  // continuity (Sprint 9 shipped it briefly, but treat the value as ms here
  // — anyone who set `=3000` expecting 3 s gets exactly 3 s instead of 3000 s).
  const envRaw = process.env.ISLAND_SOCKET_TIMEOUT_MS ?? process.env.ISLAND_SOCKET_TIMEOUT
  if (envRaw !== undefined) {
    const parsed = parseFloat(envRaw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed)
  }
  return DEFAULT_TIMEOUT_MS
}

/** Bottom-half worker — exposed for tests so the connection factory + clock
 *  can be substituted. Production callers should use {@link sendEnvelope}.
 *
 *  Reviewer Nit-3: per-event listener overloads narrow `chunkRaw` to `Buffer`
 *  at the call site, removing the `as Buffer` cast in `socket.on('data', …)`. */
export interface SocketLike {
  on(event: 'connect', listener: () => void): this
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): this
  write(chunk: Buffer, cb?: (err?: Error | null) => void): boolean
  end(): void
  destroy(err?: Error): void
}

export interface SocketFactory {
  (socketPath: string): SocketLike
}

const defaultFactory: SocketFactory = (socketPath) =>
  net.createConnection({ path: socketPath }) as unknown as SocketLike

/**
 * Send one envelope. Promise resolves to either `{ok:true, response}` (the
 * peer wrote a JSON response or simply closed with no body) or
 * `{ok:false, reason, detail}`. Promise never rejects — fail-open.
 */
export function sendEnvelope(
  envelope: BridgeEnvelope,
  opts?: SendOpts & { factory?: SocketFactory }
): Promise<SendOutcome> {
  return new Promise<SendOutcome>((resolve) => {
    let bytes: Buffer
    try {
      bytes = serializeEnvelope(envelope)
    } catch (err) {
      resolve({
        ok: false,
        reason: 'protocol',
        detail: err instanceof Error ? err.message : String(err)
      })
      return
    }
    if (bytes.length > MAX_ENVELOPE_BYTES) {
      resolve({ ok: false, reason: 'protocol', detail: `envelope > ${MAX_ENVELOPE_BYTES} bytes` })
      return
    }

    const socketPath = resolveSocketPath(opts)
    const timeoutMs = resolveTimeoutMs(opts)
    const factory = opts?.factory ?? defaultFactory

    let socket: SocketLike
    try {
      socket = factory(socketPath)
    } catch (err) {
      resolve({
        ok: false,
        reason: 'unknown',
        detail: err instanceof Error ? err.message : String(err)
      })
      return
    }

    let response = Buffer.alloc(0)
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    /** Reviewer M1: track whether `'connect'` ever fired so a `'close'`-only
     *  termination can distinguish "peer accepted then RST" (real failure)
     *  from "peer half-closed after our write" (legit fail-open success). */
    let connectFired = false

    const settle = (outcome: SendOutcome): void => {
      if (settled) return
      settled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      try {
        socket.destroy()
      } catch {
        // best-effort
      }
      resolve(outcome)
    }

    timeoutId = setTimeout(() => {
      settle({ ok: false, reason: 'timeout', detail: `socket deadline ${timeoutMs}ms` })
    }, timeoutMs)

    socket.on('connect', () => {
      connectFired = true
      socket.write(bytes, (writeErr) => {
        if (writeErr) {
          settle({ ok: false, reason: 'unknown', detail: writeErr.message })
          return
        }
        // POSIX shutdown(SHUT_WR) — `socket.end()` without args closes the
        // write-half but keeps the read-half open, which is exactly what
        // ping-island's NIO half-close pattern expects per §3.1.
        socket.end()
      })
    })

    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk])
      if (response.length > MAX_RESPONSE_BYTES) {
        settle({
          ok: false,
          reason: 'protocol',
          detail: `response > ${MAX_RESPONSE_BYTES} bytes`
        })
      }
    })

    socket.on('end', () => {
      if (settled) return
      if (response.length === 0) {
        settle({ ok: true, response: null })
        return
      }
      try {
        const parsed = JSON.parse(response.toString('utf8'))
        settle({ ok: true, response: parsed })
      } catch (parseErr) {
        settle({
          ok: false,
          reason: 'protocol',
          detail: parseErr instanceof Error ? parseErr.message : String(parseErr)
        })
      }
    })

    socket.on('close', () => {
      if (settled) return
      // Reviewer M1: a `'close'` with NO prior `'connect'` and NO prior
      // `'error'` means the kernel either rejected the connect outright
      // (some platforms surface this only through `'close'`) OR the peer
      // accepted then immediately RST. Either way, treat as `unknown`
      // failure so the probe state machine doesn't see it as healthy.
      if (!connectFired) {
        settle({ ok: false, reason: 'unknown', detail: 'closed before connect' })
        return
      }
      // `'connect'` did fire — the write half-close was acknowledged by the
      // peer dropping the connection without writing a body. This is the
      // legit "one-shot peer" pattern: silent success.
      settle({ ok: true, response: null })
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? ''
      if (code === 'ENOENT') {
        settle({ ok: false, reason: 'enoent', detail: err.message })
      } else if (code === 'ECONNREFUSED') {
        settle({ ok: false, reason: 'refused', detail: err.message })
      } else if (code === 'ETIMEDOUT') {
        settle({ ok: false, reason: 'timeout', detail: err.message })
      } else {
        settle({
          ok: false,
          reason: 'unknown',
          detail: err.message || String(err)
        })
      }
    })
  })
}

/** Wire-level constants exposed for tests. The Settings page does NOT consume
 *  these — it reads the resolved socket path from `useIslandStore.socketPath`
 *  (mirrored via `getIslandStatus()`). Reviewer Nit-2: comment kept tests-only
 *  so the next reader doesn't grep for a phantom UI hint usage. */
export const __wire = {
  MAX_ENVELOPE_BYTES,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SOCKET_PATH
}
