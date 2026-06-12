/// <reference lib="webworker" />
//
// MailAgent PWA service worker (REMOTE-ACCESS §7.2 / §9 / §12).
//
// Built as its own IIFE bundle → out/web/sw.js (see vite.web.config.ts
// rollupOptions input `sw`). Registered by src/web/register-sw.ts with
// scope /app/.
//
// Caching policy — three rules, deliberately NOT caching email data:
//   1. /api/*  → NetworkFirst (8s timeout). Email state changes fast; a
//      stale cache misleads the user (§7.2/§9 "don't cache email data").
//      NetworkFirst is the CAP — it only serves cache when the network
//      times out / is offline. Workbox caches GET only, so mutating
//      POST/DELETE writes are never persisted. We further skip caching the
//      enumerable list/search endpoints entirely (see apiNoStore) so even a
//      transient offline read can't surface a stale inbox.
//   2. static assets (script/style/image/font) → CacheFirst (versioned
//      cache name). Hashed Vite asset filenames make these immutable.
//   3. navigations → NetworkFirst falling back to the cached app shell
//      (index.html). This is the "precache app shell" guarantee: once the
//      shell is fetched, deep-link refreshes work offline. (SPA history
//      fallback for sub-routes is ALSO handled at the host layer — see the
//      build handoff note about Cloudflare Pages _redirects /app/* → 200.)
//
// skipWaiting + clientsClaim so a long-tail client never gets stuck on a
// stale SPA build (§12 risk "拿到旧 SPA 缓存").

import { clientsClaim } from 'workbox-core'
import { registerRoute, setCatchHandler } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()

const SHELL_CACHE = 'shell-v1'
const STATIC_CACHE = 'static-v1'
const API_CACHE = 'api-v1'

// Cache the app shell on install so the very first offline navigation has
// something to serve. Asset bundles are picked up lazily by the static
// CacheFirst route below (their URLs are content-hashed, so they self-bust).
const SHELL_URL = `${self.registration.scope}` // scope === '/app/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // index.html is served at the scope root for an SPA.
      cache.add(new Request(SHELL_URL, { cache: 'reload' })).catch(() => undefined)
    )
  )
})

// Drop old cache versions on activate so renamed caches don't accumulate.
self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, STATIC_CACHE, API_CACHE])
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
  )
})

// 1) API: NetworkFirst with a hard timeout. Enumerable inbox/search reads are
//    excluded from caching entirely (responses not stored) so offline can
//    never paint a stale list; point reads still get an 8s offline grace.
const API_NO_STORE = [/\/api\/email\/list/, /\/api\/email\/list-enriched/, /\/api\/email\/search/]

const apiNetworkFirst = new NetworkFirst({ cacheName: API_CACHE, networkTimeoutSeconds: 8 })

registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  async (params) => {
    const res = await apiNetworkFirst.handle(params)
    // If this is a list/search endpoint, evict it right back out of the cache
    // so the NetworkFirst fallback never serves a stale enumeration later.
    const path = new URL(params.request.url).pathname
    if (API_NO_STORE.some((re) => re.test(path))) {
      caches
        .open(API_CACHE)
        .then((c) => c.delete(params.request))
        .catch(() => undefined)
    }
    return res
  }
)

// 2) Static assets — CacheFirst, content-hashed filenames are immutable.
registerRoute(
  ({ request }) => ['script', 'style', 'image', 'font'].includes(request.destination),
  new CacheFirst({ cacheName: STATIC_CACHE })
)

// 3) Navigations — NetworkFirst, fall back to the cached shell when offline.
const shellNetworkFirst = new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4 })
registerRoute(({ request }) => request.mode === 'navigate', shellNetworkFirst)

// Last-resort offline fallback for navigations: serve the cached shell so a
// deep-link refresh (e.g. /app/inbox/123) renders the SPA instead of a
// browser error page.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE })
    if (cached) return cached
  }
  return Response.error()
})
