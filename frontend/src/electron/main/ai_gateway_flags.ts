// chat-panel P4 Phase 06a (cutover) — main-side resolution of the NEW_SESSION_DEFAULT master.
//
// Shared by index.ts (whether to START the embedded gateway + inject ?aiGatewayPort=) and
// ai_gateway_lifecycle.ts (whether to default context-injection ON). Kept in ONE module — not
// inlined in both, and NOT exported from index.ts (lifecycle is dynamically imported by index, so
// importing back would be circular) — so the two main entry points can never drift.
//
// Resolution mirrors the renderer flags.ts: an explicit env var wins; otherwise the build-time
// master const baked by electron.vite (both the `main` and `renderer` define blocks reference the
// same AI_SDK_NEW_SESSION_DEFAULT — '' in Chunk B → off/dark, flipped to '1' at cutover). Under
// vitest there is no define → the const is undefined → master off, so main-side tests stay default-off.

declare const __MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__: string | undefined

function truthyFlag(raw: string | undefined | null): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** Master on = an explicit MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT env wins, else the build-time const
 *  (electron.vite main+renderer define). Undefined const (vitest / un-injected) → off. */
export function masterNewSessionDefaultOn(): boolean {
  const env = process.env.MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT
  if (env != null) return truthyFlag(env)
  return typeof __MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__ !== 'undefined'
    ? truthyFlag(__MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__)
    : false
}

/** Whether the main process should start the embedded AI SDK Gateway (and inject ?aiGatewayPort=).
 *  An explicit MAILAGENT_AI_SDK_GATEWAY wins (manual dogfood opt-in / opt-out);
 *  MAILAGENT_CHAT_RUNTIME=legacy (or external-store / ag-ui) is the one-key rollback → no gateway;
 *  otherwise the NEW_SESSION_DEFAULT master decides. Mirrors the renderer's isAiSdkGatewayEnabled so
 *  the renderer never resolves to the AI SDK runtime without a gateway actually listening. */
export function shouldStartEmbeddedGateway(): boolean {
  if (process.env.MAILAGENT_AI_SDK_GATEWAY != null) {
    return process.env.MAILAGENT_AI_SDK_GATEWAY === 'true'
  }
  const rt = (process.env.MAILAGENT_CHAT_RUNTIME ?? '').trim().toLowerCase()
  if (rt === 'ai-sdk') return true // explicit ai-sdk runtime opt-in → start (mirrors renderer)
  if (rt === 'legacy' || rt === 'external-store' || rt === 'ag-ui') return false // rollback → off
  return masterNewSessionDefaultOn() // unset → the master decides
}
