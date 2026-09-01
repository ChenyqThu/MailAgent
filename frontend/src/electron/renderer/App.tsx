// App root. Three concerns:
//   1. Side-effect imports: i18n init.
//   2. Appearance boot — DOM is already coloured by the inline bootstrap in
//      index.html; this just syncs the zustand store + registers the
//      matchMedia listener for system mode.
//   3. TanStack Query provider — Sprint 2 adds it so EmailList's 5s poll
//      and EmailDetail's cache-by-internal-id reads have a host.

import { lazy, Suspense, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '@shared/i18n'
import { bootAppearance } from '@shared/state/appearance'
import { installFileDropGuard } from '@shared/lib/fileDropGuard'
import { makeMailApi } from '@shared/api/factory'
import { setUpdaterStatus } from '@shared/state/updater'
import { setIslandStatus } from '@shared/state/island'
import { AppRouter } from '@shared/router'
import { ErrorBoundary } from '@shared/components/ErrorBoundary'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { ToastContainer } from '@shared/components/Toast'
import { UpdateReadyBanner } from '@shared/components/UpdateReadyBanner'
import { useApiReadyRefresh } from '@shared/hooks/useApiReadyRefresh'
import { useEventBridge } from '@shared/hooks/useEventBridge'
import { useStartupPrefetch } from '@shared/hooks/useStartupPrefetch'
import { usePopoutMode } from '@shared/state/popout-mode'
import { useDetachedMode } from '@shared/state/detached-mode'

const PopoutShell = lazy(() =>
  import('@shared/components/chat/PopoutShell').then((module) => ({
    default: module.PopoutShell
  }))
)

// task 08-27 P5 — 轻窗（在新窗口打开一封邮件 / 一份报告）。同 PopoutShell 懒挂：
// 主窗永远走不到这个分支，没必要把邮件详情 + 报告渲染器一起拉进首屏 chunk。
const DetachedShell = lazy(() =>
  import('@shared/components/DetachedShell').then((module) => ({
    default: module.DetachedShell
  }))
)

/** Sprint 16 — must live inside QueryClientProvider because useEventBridge
 *  uses useQueryClient(). One mount per App lifetime; no UI of its own. */
function EventBridgeMount(): null {
  useEventBridge()
  return null
}

/** 速赢包 §4c — serve-api 软门控就绪 (main 广播 'mailagent:api-ready') 后失效 serve-api
 *  系 query。与 EventBridgeMount 同理住在这里: 需要 QueryClient、每个 App 生命周期只挂
 *  一次、自身无 UI。 */
function ApiReadyRefreshMount(): null {
  useApiReadyRefresh()
  return null
}

/** 启动预热 (task 08-20-perf-shell-prefetch-sidebar §①) — T0 让位邮件首屏; T1 邮件
 *  列表首次成功 + idle 后预载 matters/contacts chunk; T2 serve-api 就绪 + 再一次 idle
 *  后预热两个工作台的列表数据。范式同 EventBridgeMount (QueryClient 内、单挂、无 UI);
 *  只挂 inbox shell —— popout 绕过 router, 邮件列表 query 也不在, 预热无意义。 */
function StartupPrefetchMount(): null {
  useStartupPrefetch()
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
            // 速赢包 §1 —— gcTime 默认 5min: 切走超过 5 分钟(日常最常见的窗口)缓存被回收,
            // 切回等于完整冷加载。桌面 app 是常驻进程, 用内存换体验把回收推到 30min。
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1
          }
        }
      })
  )

  useEffect(() => {
    bootAppearance()
  }, [])

  // L0 — composer 拖拽附件的全局配套: 拖文件脱靶到 composer 外时, Chromium 默认
  // 会把窗口导航到 file:// (毁掉 app)。document 级兜底只阻断文件拖放的默认导航;
  // composer 内 drop 在其 <main> 上先于 document 冒泡处理, 文本拖拽不含 Files 不拦。
  // installFileDropGuard 返回卸载函数, 直接作 effect cleanup (StrictMode 双挂安全)。
  useEffect(() => installFileDropGuard(), [])

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
  // task 08-27 P5 — 轻窗与 popout 同源：判据在 React.render 之前 boot 好，第一次读就是终值。
  // 排在 popout 之前只是消歧（两个 query 同时在场只可能来自手敲 URL），主进程各开各的窗，
  // 一个窗口恒只带一种 query。
  const isDetached = useDetachedMode((s) => s.isDetached)

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* EventBridge needs QueryClient but doesn't read router state,
            so it stays here regardless of popout vs inbox shell. */}
        <EventBridgeMount />
        {/* 同上: 只依赖 QueryClient, popout / inbox 两种 shell 都要 (popout 里的
            事项/通讯录数据同样走 serve-api)。 */}
        <ApiReadyRefreshMount />
        {isDetached ? (
          <Suspense fallback={<Skeleton rows={6} className="h-full w-full p-6" width="2/3" />}>
            <DetachedShell />
          </Suspense>
        ) : isPopout ? (
          <Suspense fallback={<Skeleton rows={6} className="h-full w-full p-6" width="2/3" />}>
            <PopoutShell />
          </Suspense>
        ) : (
          <>
            {/* Sprint 7 D2 fix (Sprint 8 verify): GlobalShortcuts +
                KeyboardHelpModal + CommandPalette moved into rootRoute's
                RootLayout (see `src/shared/router-instance.tsx`) — they
                call useNavigate(), which must resolve inside
                RouterProvider, not as its sibling here. */}
            <StartupPrefetchMount />
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
