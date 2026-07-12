// App root. Three concerns:
//   1. Side-effect imports: i18n init.
//   2. Appearance boot — DOM is already coloured by the inline bootstrap in
//      index.html; this just syncs the zustand store + registers the
//      matchMedia listener for system mode.
//   3. TanStack Query provider — Sprint 2 adds it so EmailList's 5s poll
//      and EmailDetail's cache-by-internal-id reads have a host.

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '@shared/i18n'
import { bootAppearance } from '@shared/state/appearance'
import { makeMailApi } from '@shared/api/factory'
import { setUpdaterStatus } from '@shared/state/updater'
import { setIslandStatus } from '@shared/state/island'
import { AppRouter } from '@shared/router'
import { ErrorBoundary } from '@shared/components/ErrorBoundary'
import { ToastContainer } from '@shared/components/Toast'
import { UpdateReadyBanner } from '@shared/components/UpdateReadyBanner'
import { PopoutShell } from '@shared/components/chat/PopoutShell'
import { useEventBridge } from '@shared/hooks/useEventBridge'
import { usePopoutMode } from '@shared/state/popout-mode'

/** Sprint 16 — must live inside QueryClientProvider because useEventBridge
 *  uses useQueryClient(). One mount per App lifetime; no UI of its own. */
function EventBridgeMount(): null {
  useEventBridge()
  return null
}

export default function App(): React.ReactElement {
  // The client lives in a useState so HMR doesn't recreate it on every
  // edit (would lose the in-flight cache). One QueryClient per renderer
  // lifetime is the documented pattern.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Stale-while-revalidate baseline. EmailList overrides
            // refetchInterval at the per-query level; everything else
            // (mailbox list, AI fields) stays cached until invalidated.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1
          }
        }
      })
  )

  useEffect(() => {
    bootAppearance()
  }, [])

  // 应用级单次订阅 updater / island 事件 → 写入对应 zustand store。
  // 之前每个路由的 StatusBar 各自订阅一份, 路由切换 remount 导致 ipcRenderer
  // 监听累积 (dev Fast Refresh 下报 MaxListenersExceededWarning)。收敛到 App
  // 一次订阅, StatusBar / 设置页仅通过 store selector 读取。makeMailApi 是模块
  // 级单例, 引用稳定; 空依赖 → 整个 app 生命周期只订阅一次, 卸载时清理。
  useEffect(() => {
    const api = makeMailApi()
    void api.updater
      .status()
      .then(setUpdaterStatus)
      .catch(() => {
        /* preload missing in tests / web stub — keep initial seed */
      })
    void api.island
      .status()
      .then(setIslandStatus)
      .catch(() => {
        /* web stub — keep initial idle state */
      })
    const unsubUpdater = api.updater.onEvent((next) => setUpdaterStatus(next))
    const unsubIsland = api.island.onEvent((next) => setIslandStatus(next))
    return () => {
      unsubUpdater()
      unsubIsland()
    }
  }, [])

  // Sprint 14 PR E — popout window mounts a dedicated chrome instead of
  // the inbox router. The flag was set by renderer/main.tsx before
  // React.render so this first read is already correct (no flash of
  // inbox UI). Popout shell bypasses TanStack Router entirely; that
  // means no Sidebar / EmailList / Settings inside the popout — which
  // is the whole point of the dedicated window.
  const isPopout = usePopoutMode((s) => s.isPopout)

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* EventBridge needs QueryClient but doesn't read router state,
            so it stays here regardless of popout vs inbox shell. */}
        <EventBridgeMount />
        {isPopout ? (
          <PopoutShell />
        ) : (
          <>
            {/* Sprint 7 D2 fix (Sprint 8 verify): GlobalShortcuts +
                KeyboardHelpModal + CommandPalette moved into rootRoute's
                RootLayout (see `src/shared/router-instance.tsx`) — they
                call useNavigate(), which must resolve inside
                RouterProvider, not as its sibling here. */}
            <AppRouter />
            {/* Auto-update §6 (gap B) — proactive "新版本已就绪" floating card.
                Inbox-shell ONLY (inside the non-popout branch): the popout is a
                distraction-free single-email chat, so a global app-restart card
                must not surface inside it (re-review MEDIUM). Self-gates on
                status.enabled + state==='downloaded' (renders null otherwise). */}
            <UpdateReadyBanner />
          </>
        )}
        {/* Sprint 5 §2.2 — toast stack mounts once at root so any
            component (EmailToolbar / BatchActionBar / chat panel) can
            fire success/error/long-task toasts via the shared store.
            Toast is router-agnostic, so it stays outside the router. */}
        <ToastContainer />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
