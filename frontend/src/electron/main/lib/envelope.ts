// Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — shared write
// envelope helpers extracted from admin.ts / calendar.ts / write_ops.ts.
// All three handler files used the same three pieces verbatim:
//   1. `WriteEnvelope<T>` discriminated union — the {ok, data | code+message+hint}
//      shape that survives the Electron IPC boundary (codex M-3 from Sprint 3).
//   2. `envelopeFromCli<T>(promise)` — wrap a CLI invocation into the envelope
//      shape so the renderer can branch on `.ok` without try/catch.
//   3. `ensureInternalId(value, channel)` — runtime guard for the first arg
//      of IPC channels that take a non-negative integer id.
//
// Keeping these in three places risked drift (the next reviewer adding a
// new error code on one but not the others). Single SSoT here.

import { CliError } from '../cli_runner'

export type WriteEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string }

export function envelopeFromCli<T>(p: Promise<unknown>): Promise<WriteEnvelope<T>> {
  return p.then(
    (data): WriteEnvelope<T> => ({ ok: true, data: data as T }),
    (err: unknown): WriteEnvelope<T> => {
      if (err instanceof CliError) {
        return { ok: false, code: err.errorCode, message: err.message, hint: err.hint }
      }
      // D1 — writes now forward to the loopback daemon (serve-api) via
      // http_client, which throws an ApiError (a plain Error carrying a string
      // `code` + optional `hint`). Preserve both so the renderer keeps
      // branching on `err.code === 'E_NOT_FOUND'` exactly as with CliError.
      if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
        const e = err as Error & { code: string; hint?: string }
        return { ok: false, code: e.code, message: e.message, hint: e.hint }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'E_DISPATCH', message }
    }
  )
}

/** Return a typed envelope error when `value` is not a non-negative integer,
 *  otherwise return the value coerced to `number`. Callers do
 *  `if (typeof out !== 'number') return out` to short-circuit. */
export function ensureInternalId(value: unknown, channel: string): WriteEnvelope<never> | number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return {
      ok: false,
      code: 'E_INVALID_ARG',
      message: `${channel}: expected non-negative integer internalId, got ${String(value)}`
    }
  }
  return value as number
}
