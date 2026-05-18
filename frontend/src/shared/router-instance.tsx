/* eslint-disable react-refresh/only-export-components */
// A router instance is a module-level singleton (TanStack Router requires it)
// and is necessarily a non-component export. Co-locating the tiny root + inbox
// shell here keeps Sprint 1 file count down; Sprint 2+ split routes/*.tsx as
// the route count grows. HMR loss on edits to this file is the expected
// trade-off — every other module HMRs normally.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet
} from '@tanstack/react-router'

import { AdminLayout } from './components/layout/AdminLayout'
import { CalendarLayout } from './components/layout/CalendarLayout'
import { InboxLayout } from './components/layout/InboxLayout'
import { LlmDashboardLayout } from './components/layout/LlmDashboardLayout'
import { SearchLayout } from './components/layout/SearchLayout'
import { SettingsLayout } from './components/layout/SettingsLayout'
// Sprint 7 D2 — `?` / ⌘K / ⌘, bindings + the modals they open.
// MUST mount inside `RouterProvider` (i.e. inside this rootRoute layout),
// otherwise the `useNavigate()` call in GlobalShortcuts / CommandPalette
// fires a "useRouter must be used inside a <RouterProvider> component"
// warning every keypress. App.tsx originally tried to mount these as
// RouterProvider's sibling — co-located here so they share the router
// context with the rest of the route tree.
import { CommandPalette } from './components/command/CommandPalette'
import { GlobalShortcuts } from './components/keyboard/GlobalShortcuts'
import { KeyboardHelpModal } from './components/keyboard/KeyboardHelpModal'

function RootLayout(): React.ReactElement {
  return (
    <>
      <Outlet />
      <GlobalShortcuts />
      <KeyboardHelpModal />
      <CommandPalette />
    </>
  )
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

// Sprint 10 (c) packaged-app fix — TanStack Router defaults to
// `createBrowserHistory`, which reads `window.location.pathname`. In a packaged
// Electron app the renderer loads via `file:///.../app.asar/out/renderer/index.html`
// so the pathname is the full filesystem path, not `/`, and no registered
// route matches → users see the default "Not Found" screen with no UI.
//
// Detect "real `file://` protocol, not a dev server" and fall through to
// `createMemoryHistory({initialEntries: ['/']})`. In dev (vite serves the page
// over http://localhost) we stay on browser history so URL changes show up in
// devtools and HMR navigation works as expected.
const isPackagedFileProtocol =
  typeof window !== 'undefined' && window.location?.protocol === 'file:'

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    inboxRoute,
    searchRoute,
    adminRoute,
    llmRoute,
    calendarRoute,
    settingsRoute
  ]),
  history: isPackagedFileProtocol ? createMemoryHistory({ initialEntries: ['/'] }) : undefined
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
