/* eslint-disable react-refresh/only-export-components */
// A router instance is a module-level singleton (TanStack Router requires it)
// and is necessarily a non-component export. Co-locating the tiny root + inbox
// shell here keeps Sprint 1 file count down; Sprint 2+ split routes/*.tsx as
// the route count grows. HMR loss on edits to this file is the expected
// trade-off — every other module HMRs normally.

import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'

import { InboxLayout } from './components/layout/InboxLayout'
import { SearchLayout } from './components/layout/SearchLayout'

function RootLayout(): React.ReactElement {
  return <Outlet />
}

const rootRoute = createRootRoute({ component: RootLayout })

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: InboxLayout
})

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: SearchLayout
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([inboxRoute, searchRoute])
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
