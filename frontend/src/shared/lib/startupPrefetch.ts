// 启动预热 (task 08-20-perf-shell-prefetch-sidebar §①, 设计源 lane-c §6)。
//
// 三阶段:
//   T0 —— 什么都不做: InboxLayout 的 IPC(SQLite) query 独占首屏。
//   T1 —— 邮件主列表首次 success + 一次 idle → preloadRoute('/matters'|'/contacts')
//         (纯 chunk 预载, 零后端压力。全仓没有 TanStack <Link>, Sidebar 入口是
//         button+navigate ⇒ defaultPreload:'intent' 实际不触发 —— 这里 + Sidebar 的
//         onHover 预载一起补上这个缺口)。
//   T2 —— serve-api 可达 (mailagent:api-ready 广播 / SSE connected / config 缓存已
//         在场) **且已过 T1** + 再一次 idle → prefetch 事项主列表 + 通讯录首页 + 通知面板列表。
//         🔴 T2 挂在 T1 的 idle 回调之后: 预热必须让位邮件首屏 (红线), api-ready
//         早到也等邮件列表先落地。
//         🔴 不预热 pendingUpdates —— 纯投机的扇出面, 不在启动窗口抢 loopback 连接。
//         通知列表不属于「纯投机」: 铃铛是用户高频主动打开的面, 且预热的就是打开后
//         第一屏本身 (一条请求, 不扇出)。
//
// options 与两个工作台**同源** (matterLiveListOptions / contactListPagedOptions):
// key / queryFn / 缓存配方一体, 预热出来的缓存必然被页面首挂命中。
// flags 门控: 预热前先 ensure `/chat/config` (Sidebar 启动已在拉, 通常命中缓存),
// 关着的工作台不发列表请求。
//
// 编排逻辑与 IO 分离 (startStartupPrefetch 收 StartupPrefetchIo) —— 时序可在测试里
// 用假 IO 驱动, 不必拉起 router 单例 (它 static import InboxLayout 整棵依赖树)。

import type { Query, QueryClient } from '@tanstack/react-query'

import { createContactsApi } from '@shared/api/contacts'
import { createMattersApi } from '@shared/api/matters'
import { createNotificationsApi } from '@shared/api/notifications'
import { readLastContactVisit } from '@shared/components/contacts/contactLastVisit'
import { readContactListPrefs } from '@shared/components/contacts/contactListPrefs'
import { contactListPagedOptions } from '@shared/components/contacts/hooks'
import { matterLiveListOptions } from '@shared/components/matters/hooks'
import { notificationListOptions } from '@shared/components/notifications/hooks'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { APP_CONFIG_QUERY_KEY, fetchAppConfigFlags } from '@shared/hooks/useAppConfig'
import { EMAIL_QUERY_ROOT } from '@shared/lib/emailInvalidation'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'
import { useEventsStatusStore } from '@shared/state/eventsStatus'

export interface StartupPrefetchIo {
  /** 邮件主列表是否已首拉成功 (现查, 不订阅)。 */
  emailListReady(): boolean
  /** 订阅邮件主列表 success; 返回退订。回调可能多次触发, 编排层只消费第一次。 */
  onEmailListReady(cb: () => void): () => void
  apiReadyNow(): boolean
  /** 订阅 serve-api 就绪信号 (ipc 广播 / SSE connected); 返回退订。 */
  onApiReady(cb: () => void): () => void
  /** requestIdleCallback (fallback setTimeout 1500); 返回取消。 */
  requestIdle(cb: () => void): () => void
  /** router.preloadRoute — 纯 chunk 预载, 幂等 (router 自去重)。 */
  preloadRoute(to: '/matters' | '/contacts'): Promise<unknown>
  /** T2 数据预热 (flags 门控 + 两个工作台列表)。 */
  prefetchWorkspaceData(): Promise<void>
}

/** 编排器: T1(邮件成功→idle→chunk) → T2(api-ready→idle→数据)。返回 dispose。 */
export function startStartupPrefetch(io: StartupPrefetchIo): () => void {
  let disposed = false
  const cancels: Array<() => void> = []

  /** ready 已真则立即 next; 否则订阅等第一次触发 (触发即退订)。 */
  const once = (
    ready: () => boolean,
    subscribe: (cb: () => void) => () => void,
    next: () => void
  ): void => {
    if (ready()) {
      next()
      return
    }
    let fired = false
    const off = subscribe(() => {
      if (fired || disposed) return
      fired = true
      off()
      next()
    })
    cancels.push(off)
  }

  once(io.emailListReady, io.onEmailListReady, () => {
    cancels.push(
      io.requestIdle(() => {
        if (disposed) return
        // T1 — 纯 chunk。失败静默 (离线/构建缺 chunk 都不该影响主流程)。
        void io.preloadRoute('/matters').catch(() => {})
        void io.preloadRoute('/contacts').catch(() => {})
        // T2 挂在 T1 之后 (红线: 预热让位邮件首屏; api-ready 早到也等 T1)。
        once(io.apiReadyNow, io.onApiReady, () => {
          cancels.push(
            io.requestIdle(() => {
              if (disposed) return
              void io.prefetchWorkspaceData().catch(() => {})
            })
          )
        })
      })
    )
  })

  return () => {
    disposed = true
    for (const cancel of cancels) cancel()
  }
}

/** T2 数据预热: flags 门控后 prefetch 事项主列表 + 通讯录首页, 外加通知面板首屏。
 *  view/sort 读 localStorage —— 与 ContactsWorkspace 的 mount 初值同源
 *  (readLastContactVisit / readContactListPrefs), q 恒 '' (工作台初值)。 */
export async function prefetchWorkspaceData(queryClient: QueryClient): Promise<void> {
  const flags = await queryClient.ensureQueryData({
    queryKey: APP_CONFIG_QUERY_KEY,
    queryFn: fetchAppConfigFlags
  })
  const tasks: Array<Promise<unknown>> = [
    // 通知中心无 flag (design §8.e), 无条件预热。gcTime 30min + 面板 staleTime 4s ⇒
    // 首开面板立刻有内容, 同时后台静默刷新一次。
    queryClient.prefetchQuery(notificationListOptions(createNotificationsApi(resolveApiBaseUrl())))
  ]
  if (flags.mattersEnabled) {
    tasks.push(
      queryClient.prefetchQuery(matterLiveListOptions(createMattersApi(resolveApiBaseUrl())))
    )
  }
  if (flags.contactsEnabled) {
    const view = readLastContactVisit()?.view ?? 'known'
    const { sort } = readContactListPrefs()
    tasks.push(
      queryClient.prefetchInfiniteQuery({
        ...contactListPagedOptions(createContactsApi(resolveApiBaseUrl()), view, '', sort),
        pages: 1
      })
    )
  }
  await Promise.all(tasks)
}

function requestIdle(cb: () => void): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void) => number
    cancelIdleCallback?: (handle: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(cb)
    return () => w.cancelIdleCallback?.(handle)
  }
  const timer = window.setTimeout(cb, 1500)
  return () => window.clearTimeout(timer)
}

/** ipc.on 范式照抄 useApiReadyRefresh (含「返回值不是函数就退回 removeListener」兜底);
 *  非 Electron (web / 测试) 无 window.electron → no-op。 */
function subscribeIpc(channel: string, cb: () => void): () => void {
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
  if (!ipc) return () => {}
  const off = ipc.on(channel, cb)
  return typeof off === 'function' ? off : () => ipc.removeListener?.(channel, cb)
}

/** 真实 IO 装配 (renderer 用)。preloadRoute 由调用方注入 —— router 单例只在 hook 层
 *  import, 本模块保持可测。 */
export function makeStartupPrefetchIo(
  queryClient: QueryClient,
  preloadRoute: StartupPrefetchIo['preloadRoute']
): StartupPrefetchIo {
  const cache = queryClient.getQueryCache()
  // 判据: 任意 ['emails', …] 族 query 首次 success。主列表是这族的第一条 (补充查询
  // thread-batch/pinned 等都在主列表成功之后才会派生), 用族根判即可, 不抄 7 段 key 形状。
  const isEmailListSuccess = (query: Query): boolean =>
    query.queryKey[0] === EMAIL_QUERY_ROOT && query.state.status === 'success'
  return {
    emailListReady: () => cache.getAll().some(isEmailListSuccess),
    onEmailListReady: (cb) =>
      cache.subscribe((event) => {
        if (event.type === 'updated' && isEmailListSuccess(event.query)) cb()
      }),
    apiReadyNow: () =>
      useEventsStatusStore.getState().isConnected() ||
      queryClient.getQueryState(APP_CONFIG_QUERY_KEY)?.status === 'success',
    onApiReady: (cb) => {
      const offIpc = subscribeIpc(API_READY_CHANNEL, cb)
      const offSse = useEventsStatusStore.subscribe((state) => {
        if (state.isConnected()) cb()
      })
      return () => {
        offIpc()
        offSse()
      }
    },
    requestIdle,
    preloadRoute,
    prefetchWorkspaceData: () => prefetchWorkspaceData(queryClient)
  }
}
