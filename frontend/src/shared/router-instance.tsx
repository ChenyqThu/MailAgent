/* eslint-disable react-refresh/only-export-components */
// A router instance is a module-level singleton (TanStack Router requires it)
// and is necessarily a non-component export. Co-locating the tiny root + inbox
// shell here keeps Sprint 1 file count down; Sprint 2+ split routes/*.tsx as
// the route count grows. HMR loss on edits to this file is the expected
// trade-off — every other module HMRs normally.
//
// Sprint 11 V1.4 — route tree reorganised per the new SSoT design.
// Search-module 1:1 mockup-search.html — `/search` route removed; the
// command palette (⌘K overlay) is now the sole search entry, per
// mockup-search.html design intent. SearchLayout / SearchPage deleted.
//
//   /                  → InboxLayout  (?view=outbox|flagged|all swaps filter)
//   /admin             → parent route, no component of its own
//     /admin/llm       → LlmDashboardLayout    (was /llm)
//     /admin/kanban    → AdminLayout           (was /admin)
//     /admin/calendar  → CalendarLayout        (was /calendar)
//   /settings          → SettingsLayout
//
// `/admin` itself routes to `/admin/kanban` by default so a direct visit
// lands somewhere useful instead of an empty parent.

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

// Sprint 11 V1.4 — Inbox `view` is the sidebar mailbox selector (in
// state/email-filter as `view: EmailView`). URL ↔ store sync lives in
// InboxLayout (Step 8). `validateSearch` clamps unknown / missing values
// to 'inbox' so a hand-typed URL never crashes the route. The default
// `view=inbox` is intentionally omitted from the URL when its value is the
// default — TanStack Router's `stripSearchParams` handles that.
export type InboxView = 'inbox' | 'outbox' | 'flagged' | 'all'
// `view` is optional in the type — TanStack Router uses this to derive
// whether `search` must be passed to `navigate({to:'/'})`. We always
// return a concrete value at runtime via `validateSearch`, so consumers
// reading `useSearch({from:'/'}).view` get a non-null value, but writers
// can navigate to '/' without ceremony when they don't care about the
// view (e.g. when the active row click already invoked `setView` and just
// wants to land on inbox).
export interface InboxSearch {
  view?: InboxView
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: InboxLayout,
  validateSearch: (search: Record<string, unknown>): InboxSearch => {
    const v = search.view
    if (v === 'outbox' || v === 'flagged' || v === 'all' || v === 'inbox') {
      return { view: v }
    }
    return { view: 'inbox' }
  }
})

// `/admin` is a parent route that only renders <Outlet/> — visit a child
// directly (/admin/llm, /admin/kanban, /admin/calendar). The Sidebar +
// CommandPalette always navigate to a specific child, never to `/admin`
// alone. The Outlet component keeps the route legal in TanStack Router's
// nested model without rendering anything of its own.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: Outlet
})

const adminLlmRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'llm',
  component: LlmDashboardLayout
})

const adminKanbanRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kanban',
  component: AdminLayout
})

const adminCalendarRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'calendar',
  component: CalendarLayout
})

// Sprint 18 §PR C — `?tab=` deep-link. Validated enum so a malformed link
// (`/settings?tab=rogue`) silently falls back to "general" rather than
// rendering a blank pane. Tab order mirrors SettingsRail (the user-facing
// nav). The cast through `as SettingsTab` after the includes() check is
// safe — includes() narrows on string literals.
export const SETTINGS_TABS = [
  'general',
  'accounts',
  'sync',
  'ai',
  'notifications',
  'integrations',
  'realtime',
  'island'
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
  validateSearch: (search: Record<string, unknown>): { tab: SettingsTab } => {
    const t = search.tab
    if (typeof t === 'string' && (SETTINGS_TABS as readonly string[]).includes(t)) {
      return { tab: t as SettingsTab }
    }
    return { tab: 'general' }
  }
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
    adminRoute.addChildren([adminLlmRoute, adminKanbanRoute, adminCalendarRoute]),
    settingsRoute
  ]),
  history: isPackagedFileProtocol ? createMemoryHistory({ initialEntries: ['/'] }) : undefined,
  defaultPreload: false
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
