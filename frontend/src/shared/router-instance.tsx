/* eslint-disable react-refresh/only-export-components */
// A router instance is a module-level singleton (TanStack Router requires it)
// and is necessarily a non-component export. Co-locating the tiny root + inbox
// placeholder components here keeps Sprint 0 file count down; Sprint 1 will
// split routes/*.tsx as the route count grows. HMR loss on edits to this file
// is the expected trade-off — every other module HMRs normally.
//
// Sprint 0 = root + inbox placeholder; Sprint 1-6 add /search /admin /llm
// /calendar /settings here. See ARCHITECTURE.md §3 + §5.

import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'

function RootLayout(): JSX.Element {
  return <Outlet />
}

function InboxPlaceholder(): JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-micro tracking-widest text-ink-fg-2">MAILAGENT · SPRINT 0</div>
        <div className="text-subj">Scaffold ready.</div>
        <div className="text-meta text-ink-fg-2">
          Sprint 1: data layer · IPC handlers · TitleBar
        </div>
      </div>
    </main>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: InboxPlaceholder
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([inboxRoute])
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
