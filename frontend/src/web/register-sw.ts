// Service-worker registration (REMOTE-ACCESS §7.2 / §12).
//
// Kept separate from sw.ts: this runs in the WINDOW context (imports DOM
// globals), while sw.ts runs in the ServiceWorker global scope and is built
// as its own bundle. Registering manually (vs vite-plugin-pwa) keeps the
// web build at zero new heavy plugin deps — only the workbox-* runtime libs.

const SW_URL = `${import.meta.env.BASE_URL}sw.js`

export function registerServiceWorker(): void {
  // Only in production + secure context. The dev server must NOT be shadowed
  // by a cached SW (would serve stale modules and break HMR).
  if (import.meta.env.DEV) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: import.meta.env.BASE_URL })
      .catch((err) => {
        // A failed SW registration must never break the app — the SPA works
        // fine online without it; the SW only adds offline-shell + caching.
        console.warn('[pwa] service worker registration failed:', err)
      })
  })
}
