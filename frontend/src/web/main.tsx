// Web (SPA / PWA) entry point — the V2 remote-access build target.
//
// Mirrors src/electron/renderer/main.tsx but drops the two Electron-only
// branches:
//   - onboarding (?onboarding=1): there is no native onboarding window on
//     the web; remote users are already provisioned via Cloudflare Access.
//   - popout boot (bootPopoutModeFromQuery) 与轻窗 boot
//     (bootDetachedModeFromQuery, task 08-27 P5): 两者都是 Electron 主进程开出来的
//     第二个 BrowserWindow。web SPA 是单文档, 两个模式 store 都停在默认 (off),
//     App 渲染正常的 inbox shell; 对应的入口也按 canOpenDetachedWindow() 不渲染。
//
// Everything else (i18n init, appearance/theme boot, TanStack Query, router)
// lives INSIDE the shared App component, which imports only `@shared/*`
// (verified 0 `@renderer` refs), so the same App.tsx drives both targets.

import '../electron/renderer/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '../electron/renderer/App'

import { registerServiceWorker } from './register-sw'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// PWA: register the service worker after the app has mounted. No-op on
// the dev server (guarded inside) so HMR isn't shadowed by a stale SW.
registerServiceWorker()
