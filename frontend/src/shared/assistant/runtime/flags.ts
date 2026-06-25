// chat-panel P4 Phase 01 — assistant-ui shell feature flags.
//
// Two renderer-facing build-time flags gate the assistant-ui chat shell:
//   - MAILAGENT_ASSISTANT_UI_PANEL : `1` → AIChatPanel renders the new
//     assistant-ui shell; anything else (default) → legacy panel, byte-identical.
//   - MAILAGENT_CHAT_RUNTIME       : runtime adapter selection. Phase 01 only
//     ships the legacy ExternalStore adapter, so the meaningful values here are
//     `legacy` (default) and `external-store` (alias `ai-sdk` / `ag-ui` are
//     reserved for later phases and currently fold into `external-store`).
//
// Delivery: electron.vite.config.ts (desktop) + vite.web.config.ts (web) inject
// the two values as the compile-time string constants `__MAILAGENT_ASSISTANT_UI_PANEL__`
// / `__MAILAGENT_CHAT_RUNTIME__` via Vite `define` — read from `process.env` at
// build/serve time. We deliberately do NOT use Vite `envPrefix: ['MAILAGENT_']`:
// that would embed EVERY `MAILAGENT_*` env into the client bundle, including the
// `MAILAGENT_CLI_API_KEY` secret (see electron/main/lib/env-keys.ts SECRET set).
// Surgical per-flag `define` injects only these two non-secret toggles.
//
// Test/Node lane: under vitest there is no `define`, so the build constants are
// undefined; the resolver falls back to `process.env` so a test can flip the
// flag with `vi.stubEnv('MAILAGENT_ASSISTANT_UI_PANEL', '1')`. In the packaged
// renderer `process` is absent (contextIsolation), so the build constant is the
// only source — exactly the "flag-off ⇒ assistant-ui never loads" contract.

// Ambient build-time constants injected by the Vite `define` blocks. Undefined
// under vitest (no define) — every read is typeof-guarded so an undeclared
// identifier never throws a ReferenceError.
declare const __MAILAGENT_ASSISTANT_UI_PANEL__: string | undefined
declare const __MAILAGENT_CHAT_RUNTIME__: string | undefined
// Phase 02 — renderer-facing mirror of the main-process MAILAGENT_AI_SDK_GATEWAY
// flag, so the AI SDK runtime entry only shows when the gateway is actually
// embedded. NON-secret (a boolean toggle); injected per-flag like the other two.
declare const __MAILAGENT_AI_SDK_GATEWAY__: string | undefined
// Phase 04a — renderer mirror of MAILAGENT_A2UI_TOOL_CARDS. Gates the rich A2UI tool
// cards (DraftReplyCard / NotionSyncCard / generic approval card). Off (default) → the
// assistant-ui tool slot keeps only the generic ToolTraceCard fallback (byte-identical to
// Phase 01). NON-secret; injected per-flag like the others.
declare const __MAILAGENT_A2UI_TOOL_CARDS__: string | undefined
// Phase 06 — renderer mirror of MAILAGENT_AI_SDK_CONTEXT_INJECTION. Gates the AI SDK path
// building + sending the typed AgentContextSnapshot, reading ContextChips from it, and seeding
// prior-session messages (session reload). Off (default) → the AI SDK path stays Phase-02
// context-light (no snapshot sent, empty initial thread), byte-identical. NON-secret per-flag toggle.
declare const __MAILAGENT_AI_SDK_CONTEXT_INJECTION__: string | undefined
// Phase 06a (cutover) — renderer mirror of MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT, the MASTER switch
// that flips new chats to the AI SDK Gateway by default. When a specific sub-flag (ASSISTANT_UI_PANEL
// / CHAT_RUNTIME / AI_SDK_GATEWAY / CONTEXT_INJECTION / A2UI_TOOL_CARDS) is UNSET, the resolvers fall
// back to this master; an explicitly-set sub-flag always wins, and MAILAGENT_CHAT_RUNTIME=legacy is
// the one-key rollback. Default '' (off) here; the production build flips it to '1' at cutover
// (electron.vite/vite.web define). Under vitest there is no define → undefined → master off → every
// sub-flag keeps its byte-identical default-off. NON-secret per-flag toggle.
declare const __MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__: string | undefined

export type ChatRuntimeMode = 'legacy' | 'external-store' | 'ai-sdk'

function truthy(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** Resolve a flag to its raw string AND whether it was EXPLICITLY set. process.env
 *  (test/dev override) wins so vitest can `vi.stubEnv`; otherwise the build-time
 *  constant (production/dev renderer, where `process` is absent). The `set` bit is the
 *  crux of the Phase-06a master fallback: an env var present (even '') OR a NON-EMPTY
 *  build const counts as explicitly set → that flag wins; an absent env + an
 *  empty/undefined build const (the default, incl. every vitest read) counts as UNSET
 *  → the resolver falls back to the NEW_SESSION_DEFAULT master. */
function resolveFlagRaw(
  envKey: string,
  readBuildConst: () => string | undefined
): { set: boolean; value: string } {
  if (typeof process !== 'undefined' && process.env && process.env[envKey] != null) {
    return { set: true, value: String(process.env[envKey]) }
  }
  const fromBuild = readBuildConst()
  if (fromBuild != null && fromBuild !== '') return { set: true, value: String(fromBuild) }
  return { set: false, value: '' }
}

function buildPanelFlag(): string | undefined {
  return typeof __MAILAGENT_ASSISTANT_UI_PANEL__ !== 'undefined'
    ? __MAILAGENT_ASSISTANT_UI_PANEL__
    : undefined
}

function buildRuntimeFlag(): string | undefined {
  return typeof __MAILAGENT_CHAT_RUNTIME__ !== 'undefined' ? __MAILAGENT_CHAT_RUNTIME__ : undefined
}

function buildAiSdkGatewayFlag(): string | undefined {
  return typeof __MAILAGENT_AI_SDK_GATEWAY__ !== 'undefined'
    ? __MAILAGENT_AI_SDK_GATEWAY__
    : undefined
}

function buildA2uiToolCardsFlag(): string | undefined {
  return typeof __MAILAGENT_A2UI_TOOL_CARDS__ !== 'undefined'
    ? __MAILAGENT_A2UI_TOOL_CARDS__
    : undefined
}

function buildAiSdkContextInjectionFlag(): string | undefined {
  return typeof __MAILAGENT_AI_SDK_CONTEXT_INJECTION__ !== 'undefined'
    ? __MAILAGENT_AI_SDK_CONTEXT_INJECTION__
    : undefined
}

function buildNewSessionDefaultFlag(): string | undefined {
  return typeof __MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__ !== 'undefined'
    ? __MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT__
    : undefined
}

/** Phase 06a — is the NEW_SESSION_DEFAULT master switched on? Only true when the master
 *  flag is EXPLICITLY set truthy (env, or the prod build's '1' define). Under vitest (no
 *  define, no stub) it is off, so every sub-flag below keeps its pre-cutover default-off and
 *  the byte-identical flag-off contract holds. */
function masterNewSessionDefaultOn(): boolean {
  const m = resolveFlagRaw('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', buildNewSessionDefaultFlag)
  return m.set && truthy(m.value)
}

/** Which runtime adapter the assistant-ui shell uses:
 *  - `legacy` — the legacy MessageList view + ExternalStore.
 *  - `external-store` — assistant-ui shell + ExternalStore adapter (alias `ag-ui`).
 *  - `ai-sdk` — the AI SDK `useChatRuntime` pointed at the embedded Gateway. Only takes
 *    effect when the Gateway is reachable (panel-side isAiSdkGatewayEnabled +
 *    resolveAiGatewayBaseUrl + health); the panel falls back otherwise.
 *  Resolution (Phase 06a): an explicit MAILAGENT_CHAT_RUNTIME wins — `=legacy` is the
 *  one-key rollback, `=ai-sdk` the manual opt-in; when UNSET it follows the
 *  NEW_SESSION_DEFAULT master (on → 'ai-sdk', off → 'legacy'). */
export function getChatRuntimeMode(): ChatRuntimeMode {
  const r = resolveFlagRaw('MAILAGENT_CHAT_RUNTIME', buildRuntimeFlag)
  if (r.set) {
    const raw = r.value.trim().toLowerCase()
    if (raw === 'ai-sdk') return 'ai-sdk'
    if (raw === 'external-store' || raw === 'ag-ui') return 'external-store'
    return 'legacy'
  }
  // Unset → the master decides the default new-session runtime.
  return masterNewSessionDefaultOn() ? 'ai-sdk' : 'legacy'
}

/** True when the assistant-ui chat shell should replace the legacy AIChatPanel MessageList
 *  view. An explicit MAILAGENT_ASSISTANT_UI_PANEL wins; when UNSET it derives from the
 *  resolved runtime — any non-legacy runtime (ai-sdk / external-store) uses the assistant-ui
 *  shell, legacy uses the old view. So the master turning on (→ runtime 'ai-sdk') brings the
 *  shell with it, and MAILAGENT_CHAT_RUNTIME=legacy drops back to the legacy view. Evaluated
 *  at call time (not module load) so tests can stub the env first. */
export function isAssistantUiPanelEnabled(): boolean {
  const p = resolveFlagRaw('MAILAGENT_ASSISTANT_UI_PANEL', buildPanelFlag)
  if (p.set) return truthy(p.value)
  return getChatRuntimeMode() !== 'legacy'
}

/** True when the embedded AI SDK Gateway runtime entry is enabled (renderer mirror of the
 *  main-process MAILAGENT_AI_SDK_GATEWAY flag). An explicit flag wins; when UNSET it is on
 *  exactly when the resolved runtime is 'ai-sdk' (the gateway only serves that path). So the
 *  master default brings the gateway with it; legacy turns it off. */
export function isAiSdkGatewayEnabled(): boolean {
  const g = resolveFlagRaw('MAILAGENT_AI_SDK_GATEWAY', buildAiSdkGatewayFlag)
  if (g.set) return truthy(g.value)
  return getChatRuntimeMode() === 'ai-sdk'
}

/** Phase 04a — true when the rich A2UI tool cards replace the generic ToolTraceCard fallback
 *  (mirror of MAILAGENT_A2UI_TOOL_CARDS). An explicit flag wins (so MAILAGENT_A2UI_TOOL_CARDS=0
 *  is an independent partial rollback per phase-06 §7); when UNSET it is on when the ai-sdk
 *  runtime is active, so the cutover ships the rich cards (DraftReplyCard / SendApprovalCard) by
 *  default. Flag-off (vitest) → runtime 'legacy' → off → byte-identical to Phase 01 / 03b. */
export function isA2uiToolCardsEnabled(): boolean {
  const a = resolveFlagRaw('MAILAGENT_A2UI_TOOL_CARDS', buildA2uiToolCardsFlag)
  if (a.set) return truthy(a.value)
  return getChatRuntimeMode() === 'ai-sdk'
}

/** Phase 06 — true when the AI SDK path builds + sends the typed AgentContextSnapshot, reads
 *  ContextChips from it, and seeds prior-session messages (reload). An explicit
 *  MAILAGENT_AI_SDK_CONTEXT_INJECTION wins; when UNSET it is on when the ai-sdk runtime is active,
 *  so the cutover ships standing-context parity by default (the gateway degrades to context-light
 *  if /chat/config blips). Flag-off (vitest) → runtime 'legacy' → off → Phase-02 context-light,
 *  byte-identical. */
export function isAiSdkContextInjectionEnabled(): boolean {
  const c = resolveFlagRaw('MAILAGENT_AI_SDK_CONTEXT_INJECTION', buildAiSdkContextInjectionFlag)
  if (c.set) return truthy(c.value)
  return getChatRuntimeMode() === 'ai-sdk'
}

/** Loopback base URL of the embedded AI SDK Gateway, discovered from the
 *  `?aiGatewayPort=N` the main process injects into the window URL (same channel
 *  as `?apiPort=`, see ElectronApi.loopbackBaseUrl). Returns null when the param
 *  is absent (gateway not started / non-renderer test env) → the AI SDK runtime
 *  entry stays hidden and the panel uses the legacy ExternalStore adapter. */
export function resolveAiGatewayBaseUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('aiGatewayPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) return `http://127.0.0.1:${n}`
  } catch {
    /* non-renderer (no window) → null */
  }
  return null
}
