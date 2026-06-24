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

export type ChatRuntimeMode = 'legacy' | 'external-store' | 'ai-sdk'

function truthy(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** process.env (test/dev override) wins so vitest can `vi.stubEnv`; otherwise the
 *  build-time constant (production/dev renderer, where `process` is absent). */
function resolveFlag(envKey: string, readBuildConst: () => string | undefined): string {
  if (typeof process !== 'undefined' && process.env && process.env[envKey] != null) {
    return String(process.env[envKey])
  }
  const fromBuild = readBuildConst()
  return fromBuild != null ? String(fromBuild) : ''
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

/** True when the assistant-ui chat shell should replace the legacy AIChatPanel.
 *  Evaluated at call time (not module load) so tests can stub the env first. */
export function isAssistantUiPanelEnabled(): boolean {
  return truthy(resolveFlag('MAILAGENT_ASSISTANT_UI_PANEL', buildPanelFlag))
}

/** Which runtime adapter the assistant-ui shell uses:
 *  - `legacy` (default) / `external-store` — the Phase 01 ExternalStore adapter.
 *  - `ai-sdk` (Phase 02) — the AI SDK `useChatRuntime` pointed at the embedded
 *    Gateway. Only takes effect when the Gateway is actually reachable
 *    (isAiSdkGatewayEnabled + resolveAiGatewayBaseUrl); the panel falls back to
 *    external-store otherwise, so a misconfigured flag never breaks chat.
 *  `ag-ui` stays reserved → folds to external-store. */
export function getChatRuntimeMode(): ChatRuntimeMode {
  const raw = resolveFlag('MAILAGENT_CHAT_RUNTIME', buildRuntimeFlag).trim().toLowerCase()
  if (raw === 'ai-sdk') return 'ai-sdk'
  if (raw === 'external-store' || raw === 'ag-ui') return 'external-store'
  return 'legacy'
}

/** True when the embedded AI SDK Gateway is enabled (renderer mirror of the
 *  main-process MAILAGENT_AI_SDK_GATEWAY flag). Gates the AI SDK runtime entry so
 *  it never shows when the gateway isn't running. */
export function isAiSdkGatewayEnabled(): boolean {
  return truthy(resolveFlag('MAILAGENT_AI_SDK_GATEWAY', buildAiSdkGatewayFlag))
}

/** Phase 04a — true when the rich A2UI tool cards should replace the generic ToolTraceCard
 *  fallback (renderer mirror of MAILAGENT_A2UI_TOOL_CARDS). Off (default) → the assistant-ui
 *  tool slot keeps ONLY the generic fallback, byte-identical to Phase 01 / 03b. Evaluated at
 *  call time so tests can stub the env first. */
export function isA2uiToolCardsEnabled(): boolean {
  return truthy(resolveFlag('MAILAGENT_A2UI_TOOL_CARDS', buildA2uiToolCardsFlag))
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
