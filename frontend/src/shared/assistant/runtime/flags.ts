// S3 (07-02) — post-cutover gateway discovery. The AI SDK Gateway is the ONLY chat
// engine: the legacy TS runtime was deleted and the cutover-era build-time flags
// (MAILAGENT_CHAT_RUNTIME / MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT master + the
// PANEL / GATEWAY / A2UI / CONTEXT_INJECTION derivations / MAILAGENT_AGENT_VIEW /
// MAILAGENT_ASSISTANT_MODAL) were GA'd and removed — their ON behaviour is now
// hard-coded. Rollback = install a previous .app release, not a flag.
//
// What remains is base-URL discovery: WHERE the renderer reaches the gateway.
//   - Electron: main injects `?aiGatewayPort=N` → direct loopback.
//   - Remote web: same-origin '' → the serve-api proxy (ai_gateway_proxy.py).
//   - Neither (non-renderer test env / port missing) → null → the panel renders
//     the D7 error face (no silent engine fallback — none exists).

/** True when this is the remote web (SPA) build, NOT the Electron renderer. Mirrors the
 *  established `import.meta.env.VITE_BUILD_TARGET === 'web'` probe used across settings
 *  (EnvField / SettingsShell / AiTab): vite.web.config.ts `define`s VITE_BUILD_TARGET='web'
 *  (production web bundle), the electron build does not → Electron is non-web.
 *
 *  We ALSO honour `process.env.VITE_BUILD_TARGET` so a test can flip it with
 *  `vi.stubEnv('VITE_BUILD_TARGET','web')` — under the electron-as-node vitest runner
 *  `vi.stubEnv` populates process.env but NOT import.meta.env, so the import.meta-only
 *  read would never see it. process.env is absent in the production web bundle (browser,
 *  no `process`) and undefined-for-this-key in the Electron renderer, so this extra read
 *  changes nothing in production — Electron stays non-web (→ resolver never returns '' off-web). */
function isWebBuild(): boolean {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_BUILD_TARGET === 'web') {
    return true
  }
  try {
    return (
      (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
        ?.VITE_BUILD_TARGET === 'web'
    )
  } catch {
    return false
  }
}

/** Base URL the renderer uses to reach the AI SDK Gateway. Three branches:
 *
 *  1. `?aiGatewayPort=N` present → `http://127.0.0.1:N` (LOCAL Electron: the main process
 *     injects the loopback port; the renderer hits the embedded gateway DIRECTLY, never the
 *     serve-api proxy).
 *  2. Otherwise, on the remote WEB build → `''` (same-origin): `${''}/api/ai/chat` =
 *     `/api/ai/chat`, `${''}/health` = `/health`, both hit the serve-api proxy
 *     (src/api/routers/ai_gateway_proxy.py) which forwards to the same-machine loopback
 *     gateway. The remote browser can't reach loopback, so serve-api proxies on its behalf.
 *  3. Otherwise → `null` (non-renderer test env / port not injected) → the panel shows the
 *     gateway-unavailable error face (D7); there is no other engine to fall back to.
 *
 *  ⚠️ Consumers MUST null-check with `=== null` / `!= null`, NOT truthiness — `''` is a valid
 *  base (same-origin) but falsy. (`gatewayBaseUrl ?` / `!base` would wrongly reject web.) */

/** sessionStorage stash of the boot-injected port. The query param is the source of truth,
 *  but it can be lost mid-session in DEV: a vite forced full-reload (dep re-optimize) racing
 *  a TanStack Router search rewrite reloads the page at a URL without `?aiGatewayPort=` →
 *  without a stash the panel falls to the D7 unavailable face although the gateway is up.
 *  sessionStorage is per-WebContents and survives same-origin reloads; the packaged app
 *  never reloads so this is inert there. Popouts get the param re-injected by main and
 *  refresh their own stash on first read. */
const AI_GATEWAY_PORT_STASH_KEY = 'mailagent:aiGatewayPort'

export function resolveAiGatewayBaseUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('aiGatewayPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) {
      try {
        window.sessionStorage.setItem(AI_GATEWAY_PORT_STASH_KEY, String(n))
      } catch {
        /* storage unavailable (rare) — param path still works this load */
      }
      return `http://127.0.0.1:${n}`
    }
    const stashed = Number.parseInt(
      window.sessionStorage.getItem(AI_GATEWAY_PORT_STASH_KEY) ?? '',
      10
    )
    if (Number.isFinite(stashed) && stashed > 0) return `http://127.0.0.1:${stashed}`
  } catch {
    /* non-renderer (no window) → fall through (no port param) */
  }
  // No loopback port → on the web build, use the same-origin serve-api proxy.
  if (isWebBuild()) return ''
  return null
}
