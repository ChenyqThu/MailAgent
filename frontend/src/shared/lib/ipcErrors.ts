// Renderer-side error normalisation — single source for the idioms that were
// copy-pasted across ~40 files (P2-7).
//
// Background: main-process write handlers already collapse CliError / daemon
// ApiError / unknown into a structured WriteEnvelope ({ok:false, code, message,
// hint}); ElectronApi.unwrap re-throws it as `Error & {code, hint}`. But the
// renderer step that turns that thrown value back into a UI string had four
// parallel implementations:
//   1. `asWriteError` — byte-identical copy in EmailDetail.tsx + ComposePanel.tsx
//   2. `err instanceof Error ? err.message : String(err)` — ~30 inline copies
//   3. `(err as Error).message` — unsafe cast (assumes Error), ~20 sites
//   4. `err as { code?; message? }` — AIFieldsBlock's variant
//
// This module is that single source. It does NOT wrap IPC calls (React Query
// queryFn/mutationFn keep their own error boundary; subscriptions and one-way
// senders have no request/response error surface) — it only normalises a caught
// `unknown` into a readable message / {code, message} shape.

/** A caught write error reduced to its UI-relevant fields. */
export interface WriteErrorShape {
  code?: string
  message: string
}

/**
 * Normalise a caught write error into `{ code?, message }`. Mirrors the
 * (byte-identical) copies formerly in EmailDetail.tsx / ComposePanel.tsx:
 * an Error carries its `.message` plus any `.code` the main-process envelope
 * attached; anything else stringifies.
 */
export function asWriteError(err: unknown): WriteErrorShape {
  if (err instanceof Error) {
    return { code: (err as Error & { code?: string }).code, message: err.message }
  }
  return { message: String(err) }
}

/**
 * Reduce a caught `unknown` to a display string. Exact semantics of the
 * `err instanceof Error ? err.message : String(err)` idiom it replaces — an
 * Error yields its message, anything else stringifies. Replacing the unsafe
 * `(err as Error).message` casts with this additionally guards the non-Error
 * case (those casts produced `undefined` for a non-Error before).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 同上，但再剥掉两层给用户看没用的壳：主进程抛出来的错误经 IPC 会变成
 * `Error invoking remote method 'feedback:submit': FeedbackSubmitError: 真正的原因`。
 * 前两截是 Electron 的实现细节，直接摆给用户只会让人更懵 —— 要在界面上展示主进程的
 * 失败原因时用这个（`errorMessage` 保持原样，它的调用点大多是自己抛的错，没有这两层）。
 */
export function readableIpcError(err: unknown): string {
  return errorMessage(err)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^\w*Error:\s*/, '')
}
