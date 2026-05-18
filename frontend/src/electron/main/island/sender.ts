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
  const envRaw = process.env.ISLAND_SOCKET_TIMEOUT
  if (envRaw !== undefined) {
    const parsed = parseFloat(envRaw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 1000)
  }
  return DEFAULT_TIMEOUT_MS
}

/** Bottom-half worker — exposed for tests so the connection factory + clock
 *  can be substituted. Production callers should use {@link sendEnvelope}. */
export interface SocketLike {
  on(
    event: 'connect' | 'data' | 'end' | 'close' | 'error',
    listener: (...a: unknown[]) => void
  ): this
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

    socket.on('data', (chunkRaw: unknown) => {
      const chunk = chunkRaw as Buffer
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
      // Most platforms emit 'end' before 'close', but if the peer hangs up
      // without writing anything (or ENOENT before connect), 'close' fires
      // alone. Treat as silent success only when we have no other signal.
      if (!settled) settle({ ok: true, response: null })
    })

    socket.on('error', (errRaw: unknown) => {
      const err = errRaw as NodeJS.ErrnoException
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

/** Wire-level constants exposed for tests + UI hints (Settings page shows
 *  the resolved socket path read-only). */
export const __wire = {
  MAX_ENVELOPE_BYTES,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SOCKET_PATH
}
