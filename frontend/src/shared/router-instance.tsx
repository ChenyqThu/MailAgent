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

import { useEffect } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet
} from '@tanstack/react-router'

import { AdminLayout } from './components/layout/AdminLayout'
import { AgentsLayout } from './components/layout/AgentsLayout'
import { NotionAgentLayout } from './components/layout/NotionAgentLayout'
import { CalendarLayout } from './components/layout/CalendarLayout'
import { InboxLayout } from './components/layout/InboxLayout'
import { LlmDashboardLayout } from './components/layout/LlmDashboardLayout'
import { SessionsLayout } from './components/layout/SessionsLayout'
import { SettingsLayout } from './components/layout/SettingsLayout'
import { useActiveEmail } from './state/active-email'
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

// F6 — mailagent:// deeplink target (main/deeplink.ts shape; renderer 不能 import
// main 模块, 这里 inline 同 shape).
interface DeeplinkTarget {
  kind: 'email' | 'calendar' | 'kanban' | 'llm' | 'settings'
  id?: number
  view?: string
}

/**
 * 监听 main 转发的 'mailagent:deeplink' → router.navigate 切视图 + (email) setActive.
 * 灵动岛 open_mail/open_notion → plugin open mailagent://email/<id> → main → 这里.
 */
function useDeeplinkRouter(): void {
  useEffect(() => {
    // window.electron 由 preload (@electron-toolkit) 注入; renderer tsconfig 不含其
    // global d.ts, 跟 ElectronApi.ts 一样 cast 最小 shape.
    const ipc = (
      window as unknown as {
        electron?: {
          ipcRenderer?: {
            on(ch: string, fn: (...args: unknown[]) => void): (() => void) | void
            removeListener?(ch: string, fn: (...args: unknown[]) => void): void
          }
        }
      }
    ).electron?.ipcRenderer
    if (!ipc) return
    // ipcRenderer.on listener 是 (event, ...args); main send 的 target 在 args[1].
    const handler = (...args: unknown[]): void => {
      const target = args[1] as DeeplinkTarget
      if (!target || typeof target !== 'object') return
      switch (target.kind) {
        case 'email':
          if (typeof target.id === 'number') {
            useActiveEmail.getState().setActive(target.id)
            void router.navigate({ to: '/' })
          }
          break
        case 'calendar': {
          const v = (CALENDAR_VIEWS as readonly string[]).includes(target.view ?? '')
            ? (target.view as CalendarView)
            : 'week'
          void router.navigate({ to: '/admin/calendar', search: { view: v } })
          break
        }
        case 'kanban':
          void router.navigate({ to: '/admin/kanban' })
          break
        case 'llm':
          void router.navigate({ to: '/admin/llm' })
          break
        case 'settings': {
          const t = (SETTINGS_TABS as readonly string[]).includes(target.view ?? '')
            ? (target.view as SettingsTab)
            : 'general'
          void router.navigate({ to: '/settings', search: { tab: t } })
          break
        }
      }
    }
    // @electron-toolkit ipcRenderer.on 返回 cleanup fn (removeListener wrapper).
    const off = ipc.on('mailagent:deeplink', handler)
    return typeof off === 'function'
      ? off
      : () => ipc.removeListener?.('mailagent:deeplink', handler)
  }, [])
}

function RootLayout(): React.ReactElement {
  useDeeplinkRouter()
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

// Global "AI 会话历史" page — cross-email conversation history. Top-level
// route (not under /admin) so the sidebar AI-Agents "会话历史" entry lands
// directly here. No search params — the page owns its own search/filter state.
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsLayout
})

// /agents — Custom AI Agents 区（Agents / 报告 / Chats）。?tab= 控制激活 tab，
// 侧栏「Custom AI」「AI 会话历史」直接深链。validateSearch 把未知 tab 归到 agents。
const AGENTS_TABS = ['agents', 'reports', 'chats'] as const
// Notion Agent 区（仅 chats，notion-agent scoped）。参考 Custom AI 但暂无 agents/报告。
const notionAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notion-agent',
  component: NotionAgentLayout
})

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsLayout,
  validateSearch: (search: Record<string, unknown>): { tab: (typeof AGENTS_TABS)[number] } => {
    const tab = search.tab
    return {
      tab:
        typeof tab === 'string' && (AGENTS_TABS as readonly string[]).includes(tab)
          ? (tab as (typeof AGENTS_TABS)[number])
          : 'agents'
    }
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

// Phase 3 §3.3 — /admin/calendar?view=today|week|month|agenda|recurring.
// 默认 view=week. validateSearch clamp 非法值 → 'week' 避免 hand-typed URL 崩页.
export const CALENDAR_VIEWS = ['today', 'week', 'month', 'agenda', 'recurring'] as const
export type CalendarView = (typeof CALENDAR_VIEWS)[number]

const adminCalendarRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'calendar',
  component: CalendarLayout,
  validateSearch: (search: Record<string, unknown>): { view: CalendarView } => {
    const v = search.view
    if (typeof v === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(v)) {
      return { view: v as CalendarView }
    }
    return { view: 'week' }
  }
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
  'remote',
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

// web build (vite base=/app/) 跑在 mail.chenge.ink/app 下 → router basepath 必须 = /app,
// 否则 /app/ 不匹配任何 route → NotFound。electron (file: memory history / dev base=/) 不设。
const _baseUrl = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
const _routerBasepath =
  !isPackagedFileProtocol && _baseUrl.startsWith('/') && _baseUrl !== '/'
    ? _baseUrl.replace(/\/+$/, '')
    : undefined

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    inboxRoute,
    sessionsRoute,
    agentsRoute,
    notionAgentRoute,
    adminRoute.addChildren([adminLlmRoute, adminKanbanRoute, adminCalendarRoute]),
    settingsRoute
  ]),
  basepath: _routerBasepath,
  history: isPackagedFileProtocol ? createMemoryHistory({ initialEntries: ['/'] }) : undefined,
  defaultPreload: false
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
