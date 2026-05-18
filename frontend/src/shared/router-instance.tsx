/* eslint-disable react-refresh/only-export-components */
// A router instance is a module-level singleton (TanStack Router requires it)
// and is necessarily a non-component export. Co-locating the tiny root + inbox
// shell here keeps Sprint 1 file count down; Sprint 2+ split routes/*.tsx as
// the route count grows. HMR loss on edits to this file is the expected
// trade-off — every other module HMRs normally.

import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'

import { AdminLayout } from './components/layout/AdminLayout'
import { CalendarLayout } from './components/layout/CalendarLayout'
import { InboxLayout } from './components/layout/InboxLayout'
import { LlmDashboardLayout } from './components/layout/LlmDashboardLayout'
import { SearchLayout } from './components/layout/SearchLayout'
import { SettingsLayout } from './components/layout/SettingsLayout'

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

// Sprint 6 §2.2 — secondary routes.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminLayout
})

const llmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/llm',
  component: LlmDashboardLayout
})

const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  component: CalendarLayout
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    inboxRoute,
    searchRoute,
    adminRoute,
    llmRoute,
    calendarRoute,
    settingsRoute
  ])
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
