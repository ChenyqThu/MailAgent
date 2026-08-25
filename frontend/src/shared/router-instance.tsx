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

import { Suspense, lazy, useEffect } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useNavigate
} from '@tanstack/react-router'

import { AppShell } from './components/layout/AppShell'
import { InboxLayout } from './components/layout/InboxLayout'
import { Skeleton } from './components/feedback/LoadingSkeleton'
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
import { ComposeNewModal } from './components/email/compose/ComposeNewModal'
import { useMatterNavigation } from './components/matters/navigation'
// task 08-20-notification-center M2 批 B4 — 系统通知点击深跳：main 的通知 fanout 经
// 'notifications:navigate' 送来通知行 payload，这里用**单源解析器**收窄（不另抄判据）。
import { resolveNotificationLink } from './components/notifications/navigation'
import { requestOpenAgentSession } from './state/ai-chat-panel'
// 一级入口单源（task 08-24-l4-nav-shell Step R）：deeplink 的落点与「AI → General Agent」
// 菜单项的目标都从 registry 取，不在这里第二次写死 path。
import { NAV_ENTRIES, navEntry, navigateToNavEntry, NAV_DEEPLINK_PATH } from './navigation/registry'
import { resolveStaticNavGate } from './navigation/useNavGates'
import { navigateNotificationRoute } from './components/notifications/navigation'
import type { DeeplinkTarget } from './lib/deeplink_target'
import { clampSettingsTab, type SettingsTab } from './lib/settingsTabs'

// F6 — mailagent:// deeplink target。形状单源自 @shared/lib/deeplink_target（issue #68：
// 此前这里 inline 抄一份，理由是"renderer 不能 import main 模块" —— 属实，但正解是把类型
// 放到两边都能引的 shared/，不是抄）。

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
      // 门控通用解（Step R check ②）：kind 对应 entry 的 gate 在非组件上下文求值 ——
      // calendar 的 Windows 出范围判定（2026-08-13 拍板）由此自动生效，深链静默忽略；
      // deeplink 加新 kind 时给 entry 标 gate 即接上，不再在这里手写平台判定。
      const gateEntry = NAV_ENTRIES.find((e) => e.deeplinkKind === target.kind)
      if (gateEntry !== undefined && !resolveStaticNavGate(gateEntry.gate)) return
      // 目标 path 从 nav registry 查（`NAV_DEEPLINK_PATH` 的键域 = DeeplinkTarget['kind']
      // 全集，少一个 kind 编译期就红）；search 的形状按 kind 各不相同，仍逐个落地。
      switch (target.kind) {
        case 'email':
          if (typeof target.id === 'number') {
            useActiveEmail.getState().setActive(target.id)
            void router.navigate({ to: NAV_DEEPLINK_PATH.email })
          }
          break
        case 'calendar': {
          const v = (CALENDAR_VIEWS as readonly string[]).includes(target.view ?? '')
            ? (target.view as CalendarView)
            : 'week'
          void router.navigate({ to: NAV_DEEPLINK_PATH.calendar, search: { view: v } })
          break
        }
        case 'kanban':
          void router.navigate({ to: NAV_DEEPLINK_PATH.kanban })
          break
        case 'llm':
          void router.navigate({ to: NAV_DEEPLINK_PATH.llm })
          break
        case 'settings':
          void router.navigate({
            to: NAV_DEEPLINK_PATH.settings,
            search: { tab: clampSettingsTab(target.view) }
          })
          break
      }
    }
    // @electron-toolkit ipcRenderer.on 返回 cleanup fn (removeListener wrapper).
    const off = ipc.on('mailagent:deeplink', handler)
    return typeof off === 'function'
      ? off
      : () => ipc.removeListener?.('mailagent:deeplink', handler)
  }, [])
}

/**
 * 监听 main 菜单 (AI → General Agent) 转发的 'mailagent:open-general-agent' →
 * 导航到 MailAgent 通用 agent 视图 (/sessions)。菜单项不绑 accelerator（⌘O 由
 * renderer GlobalShortcuts 拥有），只走 click → IPC → 这里。RootLayout 仅主 shell
 * 渲染（popout 绕过 router），与 main 端「只发主窗口」对齐。legacy Cmd+O centered
 * dialog 已随 legacy runtime 退役（S3 W2）。
 */
function useGeneralAgentMenu(): void {
  const navigate = useNavigate()
  useEffect(() => {
    // 目标同侧栏「MailAgent」行 / ⌘K 的通用 agent 行 —— 三处共用 registry 的同一条 entry。
    const entry = navEntry('sessions')
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
    const handler = (): void => {
      navigateToNavEntry(navigate, entry)
    }
    const off = ipc.on('mailagent:open-general-agent', handler)
    return typeof off === 'function'
      ? off
      : () => ipc.removeListener?.('mailagent:open-general-agent', handler)
  }, [navigate])
}

/**
 * task 08-20-notification-center M2 批 B4 — 系统通知（macOS Notification）点击深跳。
 * main 的 notification_fanout 聚焦主窗口后经 'notifications:navigate' 送来
 * `{ id, payload }`（payload = 通知行 payload_json）；这里落地 session / route /
 * matter 三型（与 NotificationPanel.activate 同口径；matter 型是 M3 批 C1 老
 * `matters:navigate` 链退役后 macOS 通知进事项的唯一入口），其余型（report /
 * contact_queue / updater_restart）的系统通知点击退化为「仅聚焦主窗口」（main 侧
 * 已做），不在此处抄第二份落地逻辑。
 */
function useNotificationClickNavigation(): void {
  const navigate = useNavigate()
  useEffect(() => {
    const notificationsApi = (
      window as unknown as {
        api?: {
          notifications?: {
            onNavigate(handler: (payload: unknown) => void): () => void
          }
        }
      }
    ).api?.notifications
    if (!notificationsApi) return

    return notificationsApi.onNavigate((raw) => {
      if (!raw || typeof raw !== 'object') return
      const payload = (raw as { payload?: unknown }).payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
      const link = resolveNotificationLink(payload as Record<string, unknown>)
      if (!link) return
      if (link.type === 'session') {
        requestOpenAgentSession(link.sessionId)
        void navigate({ to: '/sessions' })
        return
      }
      if (link.type === 'matter') {
        useMatterNavigation.getState().open(link.publicId)
        void navigate({ to: '/matters' })
        return
      }
      if (link.type === 'route') {
        // 落地 switch 单源在 notifications/navigation.ts（与 NotificationPanel 共用，
        // Step R check ① 的两份手抄 switch 收敛 + `/settings` case 补齐在那边）。
        navigateNotificationRoute(navigate, link)
      }
    })
  }, [navigate])
}

// Popmenu showcase（dev-only 审批物, ⌃⇧P 开）。生产构建时 Vite 把 import.meta.env.DEV
// 换成 false → 三元折成 null, 这个动态 import 不可达, 不进 chunk 图也不渲染。
const PopmenuShowcaseMount = import.meta.env.DEV
  ? lazy(() => import('./components/dev/PopmenuShowcaseMount'))
  : null

function RootLayout(): React.ReactElement {
  useDeeplinkRouter()
  useGeneralAgentMenu()
  useNotificationClickNavigation()
  return (
    <>
      {/* 外壳单例 (§②, task 08-20-perf-shell-prefetch-sidebar): TitleBar/Sidebar/
          StatusBar 只在这里渲染一次, 路由切换只换 <Outlet/> 的中间内容区 ——
          Sidebar (含文件夹树) 不再逐路由 remount。 */}
      <AppShell>
        <Outlet />
      </AppShell>
      <GlobalShortcuts />
      <KeyboardHelpModal />
      <CommandPalette />
      {/* 写新邮件居中模态 — 全局单实例, 由侧边栏「写邮件」按钮 / ⌘N 打开。 */}
      <ComposeNewModal />
      {PopmenuShowcaseMount !== null && (
        <Suspense fallback={null}>
          <PopmenuShowcaseMount />
        </Suspense>
      )}
    </>
  )
}

function RouteLoadingSkeleton(): React.ReactElement {
  // 外壳单例后 pending 态渲染在中间内容槽 (TitleBar/Sidebar 保持在场) —— 自带
  // flex-1 吃满剩余宽度; 旧 w-full 在 flex 行里按容器全宽算会把 Sidebar 挤溢出。
  return <Skeleton rows={6} className="h-full flex-1 min-w-0 p-6" width="2/3" />
}

const rootRoute = createRootRoute({ component: RootLayout })

// Sprint 11 V1.4 — Inbox `view` is the sidebar mailbox selector (in
// state/email-filter as `view: EmailView`). URL ↔ store sync lives in
// InboxLayout (Step 8). `validateSearch` clamps unknown / missing values
// to 'inbox' so a hand-typed URL never crashes the route. The default
// `view=inbox` is intentionally omitted from the URL when its value is the
// default — TanStack Router's `stripSearchParams` handles that.
export type InboxView = 'inbox' | 'outbox' | 'drafts' | 'flagged' | 'all'
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
    if (v === 'outbox' || v === 'drafts' || v === 'flagged' || v === 'all' || v === 'inbox') {
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
  component: lazyRouteComponent(
    () => import('./components/layout/SessionsLayout'),
    'SessionsLayout'
  )
})

// /agents — Custom AI Agents 区（Agents / 报告 / Chats）。?tab= 控制激活 tab，
// 侧栏「Custom AI」「AI 会话历史」直接深链。validateSearch 把未知 tab 归到 agents。
const AGENTS_TABS = ['agents', 'reports', 'chats'] as const

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: lazyRouteComponent(() => import('./components/layout/AgentsLayout'), 'AgentsLayout'),
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

const mattersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/matters',
  component: lazyRouteComponent(() => import('./components/layout/MattersLayout'), 'MattersLayout')
})

// /contacts — 通讯录（Contact Directory WP2）。flag off 时导航不渲染，路由直达由
// ContactsWorkspace 渲染 404 空态（设计 §7：不是空页）。
const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts',
  component: lazyRouteComponent(
    () => import('./components/layout/ContactsLayout'),
    'ContactsLayout'
  )
})

// /connectors — 旧独立配置台入口保留为 redirect。`?item=` 深链到 Settings Connectors tab
// 的具体条目（builtin:<group> / connector:<id> / catalog:<id> / composio / external）。
const connectorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connectors',
  validateSearch: (search: Record<string, unknown>): { item?: string } => {
    const item = search.item
    return typeof item === 'string' && item.length > 0 ? { item } : {}
  },
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/settings',
      search: search.item ? { tab: 'connectors', item: search.item } : { tab: 'connectors' },
      replace: true
    })
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

// Index route — a bare `/admin` visit (hand-typed URL, stale deep link)
// redirects to the kanban system board instead of rendering the empty
// parent Outlet as a blank page, fulfilling the header-comment promise.
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/kanban', replace: true })
  }
})

const adminLlmRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'llm',
  component: lazyRouteComponent(
    () => import('./components/layout/LlmDashboardLayout'),
    'LlmDashboardLayout'
  )
})

const adminKanbanRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kanban',
  component: lazyRouteComponent(() => import('./components/layout/AdminLayout'), 'AdminLayout')
})

// Phase 3 §3.3 — /admin/calendar?view=today|week|month|agenda|recurring.
// 默认 view=week. validateSearch clamp 非法值 → 'week' 避免 hand-typed URL 崩页.
export const CALENDAR_VIEWS = ['today', 'week', 'month', 'agenda', 'recurring'] as const
export type CalendarView = (typeof CALENDAR_VIEWS)[number]

const adminCalendarRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'calendar',
  component: lazyRouteComponent(
    () => import('./components/layout/CalendarLayout'),
    'CalendarLayout'
  ),
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
// rendering a blank pane. 枚举本体自 Step B 起下沉到零依赖叶子
// `@shared/lib/settingsTabs`（通知落地也要 clamp 它，留在这里是 import 环）；
// 这里 re-export 保住既有消费方（SettingsShell 等）的 import 路径。
export { SETTINGS_TABS, type SettingsTab } from './lib/settingsTabs'
export interface SettingsSearch {
  tab: SettingsTab
  item?: string
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: lazyRouteComponent(
    () => import('./components/layout/SettingsLayout'),
    'SettingsLayout'
  ),
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    // clamp 走叶子的 `clampSettingsTab` —— 通知落地 / deeplink 都调它, 路由这里
    // 再手抄一遍判据就又是一处会漂的镜像 (check, Step B)。
    const tab: SettingsTab = clampSettingsTab(search.tab)
    const item = search.item
    return typeof item === 'string' && item.length > 0 ? { tab, item } : { tab }
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
    mattersRoute,
    contactsRoute,
    connectorsRoute,
    adminRoute.addChildren([adminIndexRoute, adminLlmRoute, adminKanbanRoute, adminCalendarRoute]),
    settingsRoute
  ]),
  basepath: _routerBasepath,
  history: isPackagedFileProtocol ? createMemoryHistory({ initialEntries: ['/'] }) : undefined,
  // 速赢包 §3 —— 除 `/`（InboxLayout 静态 import）外全部是 lazyRouteComponent，chunk 最大
  // 591 KB（MattersLayout）。'intent' = hover/focus 侧边栏入口就开始下载对应 chunk，点击时
  // 通常已在本地；50ms 延迟避免鼠标划过一排入口就把整棵路由树全拉下来。
  defaultPreload: 'intent',
  defaultPreloadDelay: 50,
  // 默认 1000ms 意味着 chunk 在 1s 内下载完就**完全没有**视觉反馈（点了没反应的死区）；
  // 150ms 是「不闪一下就消失」与「点击有回应」之间的常用折中。
  defaultPendingMs: 150,
  defaultPendingComponent: RouteLoadingSkeleton
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
