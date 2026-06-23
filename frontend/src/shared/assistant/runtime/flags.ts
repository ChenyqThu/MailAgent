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

export type ChatRuntimeMode = 'legacy' | 'external-store'

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

/** True when the assistant-ui chat shell should replace the legacy AIChatPanel.
 *  Evaluated at call time (not module load) so tests can stub the env first. */
export function isAssistantUiPanelEnabled(): boolean {
  return truthy(resolveFlag('MAILAGENT_ASSISTANT_UI_PANEL', buildPanelFlag))
}

/** Which runtime adapter the assistant-ui shell uses. Phase 01 only implements
 *  the legacy ExternalStore adapter; `ai-sdk` / `ag-ui` are reserved for later
 *  phases and currently resolve to `external-store` so the shell still renders. */
export function getChatRuntimeMode(): ChatRuntimeMode {
  const raw = resolveFlag('MAILAGENT_CHAT_RUNTIME', buildRuntimeFlag).trim().toLowerCase()
  if (raw === 'external-store' || raw === 'ai-sdk' || raw === 'ag-ui') return 'external-store'
  return 'legacy'
}
