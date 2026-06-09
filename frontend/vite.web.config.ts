import { resolve } from 'path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// ---------------------------------------------------------------------------
// Web (SPA / PWA) build target — REMOTE-ACCESS.md §5.
//
// Plain `vite` (NOT electron-vite): renderer-only static build. Entry is
// src/web/index.html → src/web/main.tsx, which imports the SAME shared App
// (src/electron/renderer/App.tsx, 0 `@renderer` refs) and reaches the backend
// via HttpApi (factory.ts picks HttpApi when VITE_BUILD_TARGET === 'web').
//
// Two build artifacts come out of `build:web`:
//   1. the SPA (out/web/**, ES modules, base '/app/')         ← BUILD_SW unset
//   2. the service worker (out/web/sw.js, classic IIFE)        ← BUILD_SW=1
// They are produced by two passes of this one config (see package.json
// `build:web`). A classic IIFE SW (not an ES-module worker) is used so it
// registers on the full borrowed-device matrix incl. older iOS Safari, which
// only gained module-worker support very recently.
// ---------------------------------------------------------------------------

// Electron-only native/runtime deps that must NEVER enter the web bundle.
// The import graph is already clean (grep proved better-sqlite3 / keytar /
// execa / electron* appear only in COMMENTS across src/shared + renderer, and
// ElectronApi reaches Electron via the runtime `window.electron` global, not a
// static import). These are listed as a belt-and-suspenders guard: any
// ACCIDENTAL future static import of one of them fails the build loudly here
// instead of silently shipping node code to the browser.
const ELECTRON_ONLY = [
  'better-sqlite3',
  'keytar',
  'execa',
  'electron',
  'electron-updater',
  'electron-vite'
]

const isSwBuild = process.env.BUILD_SW === '1'

export default defineConfig({
  // base '/app/' matches the PWA scope/start_url (REMOTE-ACCESS §7.1) and the
  // Cloudflare Pages mount. Affects asset URLs + import.meta.env.BASE_URL,
  // which register-sw.ts uses to locate sw.js and its scope.
  base: '/app/',

  root: isSwBuild ? __dirname : resolve(__dirname, 'src/web'),

  // The SW bundle is pure TS (no JSX); the app needs the React plugin.
  plugins: isSwBuild ? [] : [react()],

  resolve: {
    alias: {
      // @shared mirrors electron.vite.config.ts. @renderer is kept because
      // App.tsx lives physically under renderer/ and its transitive deps may
      // reference it; the web entry imports App via a relative path but the
      // alias keeps any internal `@renderer/*` resolvable.
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/electron/renderer')
    }
  },

  define: {
    // factory.ts reads this to pick HttpApi over ElectronApi.
    'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web'),
    // Workbox guards its dev logger behind `process.env.NODE_ENV`, which is
    // undefined in the browser ServiceWorker global (`process` doesn't exist
    // there) → the SW would throw on load. Define it at build time so the
    // dev-only branch is dead-code-eliminated from the IIFE bundle. (Harmless
    // for the SPA pass — Vite already sets mode-based prod constants there.)
    'process.env.NODE_ENV': JSON.stringify('production')
  },

  // Don't pre-bundle electron-only deps (none are imported, but keep esbuild
  // from ever trying to optimize them if a stray import sneaks in).
  optimizeDeps: {
    exclude: ELECTRON_ONLY
  },

  // Local dev: proxy /api → the local FastAPI so the CF_Authorization cookie
  // and same-origin semantics hold without CORS. For prod the SPA and API
  // share the tunnel domain, so VITE_API_BASE_URL stays unset → '/api'.
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8200',
        changeOrigin: true
      }
    }
  },

  build: isSwBuild
    ? {
        // Pass 2 — service worker as a single classic (IIFE) file, workbox
        // bundled in. Emitted alongside the SPA, NOT wiping it (emptyOutDir
        // false). Output name is fixed to sw.js (register-sw.ts expects it).
        outDir: resolve(__dirname, 'out/web'),
        emptyOutDir: false,
        // SW served from a stable path; no asset hashing for the entry.
        lib: {
          entry: resolve(__dirname, 'src/web/sw.ts'),
          formats: ['iife'],
          name: 'sw',
          fileName: () => 'sw.js'
        },
        rollupOptions: {
          external: ELECTRON_ONLY
        }
      }
    : {
        // Pass 1 — the static SPA.
        outDir: resolve(__dirname, 'out/web'),
        emptyOutDir: true,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/web/index.html'),
            landing: resolve(__dirname, 'src/web/landing.html')
          },
          // Defensive: fail loudly if any electron-only dep is statically
          // imported into the web graph (see ELECTRON_ONLY note above).
          external: ELECTRON_ONLY
        }
      }
})
