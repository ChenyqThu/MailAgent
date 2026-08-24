// @vitest-environment happy-dom
//
// 启动预热 (task 08-20-perf-shell-prefetch-sidebar §①) —— 时序编排 + T2 数据预热。
//
// 时序断言全部是「这次真正要保证的行为」:
//   1. 🔴 红线: T1/T2 都必须在邮件列表首批数据落地之后 —— email 未 success 时
//      preloadRoute / prefetch 一个都不能发 (api-ready 早到也不行)。
//   2. T1 (chunk) 在 email success + idle 后; T2 (数据) 还要再等 api-ready + 第二次 idle。
//   3. dispose 后一切熄火 (StrictMode 双挂 / App 卸载不漏定时器)。
//   4. prefetchWorkspaceData 写进缓存的 key 与页面的读 key 完全同源
//      (matterLiveListOptions / contactListPagedOptions + localStorage 同源初值,
//      notificationListOptions)。key 漂了 = 预热白做, 页面照样冷加载。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import {
  prefetchWorkspaceData,
  startStartupPrefetch,
  type StartupPrefetchIo
} from '@shared/lib/startupPrefetch'
import { APP_CONFIG_QUERY_KEY } from '@shared/hooks/useAppConfig'
import { qk } from '@shared/lib/queryKeys'

// ── 模块 mock: T2 数据预热的 api 工厂与 localStorage 读侧 ──────────────────
const mockMatterList = vi.fn(async () => ({ items: [], total: 0 }))
const mockContactList = vi.fn(async () => ({ items: [], total: 0, next_cursor: null }))
const mockNotificationList = vi.fn(async () => ({
  items: [],
  total: 0,
  unread: 0,
  limit: 50,
  offset: 0
}))
vi.mock('@shared/api/matters', () => ({
  createMattersApi: () => ({ list: mockMatterList })
}))
vi.mock('@shared/api/contacts', () => ({
  createContactsApi: () => ({ list: mockContactList })
}))
vi.mock('@shared/api/notifications', () => ({
  createNotificationsApi: () => ({ list: mockNotificationList })
}))
// 与 ContactsWorkspace 的 mount 初值同源: view 来自 lastVisit, sort 来自 listPrefs。
vi.mock('@shared/components/contacts/contactLastVisit', () => ({
  readLastContactVisit: () => ({ id: 7, view: 'all' })
}))
vi.mock('@shared/components/contacts/contactListPrefs', () => ({
  readContactListPrefs: () => ({ sort: 'name', groupBy: 'none', density: 'compact' })
}))

afterEach(() => {
  mockMatterList.mockClear()
  mockContactList.mockClear()
  mockNotificationList.mockClear()
})

// ── 假 IO: 手动扳机驱动时序 ────────────────────────────────────────────────
interface Harness {
  io: StartupPrefetchIo
  fireEmailReady(): void
  fireApiReady(): void
  /** 立即执行所有排队的 idle 回调 (requestIdle 假实现是入队, 不自动跑)。 */
  flushIdle(): void
  preloadRoute: ReturnType<typeof vi.fn>
  prefetchWorkspace: ReturnType<typeof vi.fn>
}

function makeHarness(opts?: { emailReadyNow?: boolean; apiReadyNow?: boolean }): Harness {
  let emailReady = opts?.emailReadyNow ?? false
  let apiReady = opts?.apiReadyNow ?? false
  const emailSubs = new Set<() => void>()
  const apiSubs = new Set<() => void>()
  const idleQueue: Array<{ cb: () => void; cancelled: boolean }> = []
  const preloadRoute = vi.fn(async () => {})
  const prefetchWorkspace = vi.fn(async () => {})
  return {
    io: {
      emailListReady: () => emailReady,
      onEmailListReady: (cb) => {
        emailSubs.add(cb)
        return () => emailSubs.delete(cb)
      },
      apiReadyNow: () => apiReady,
      onApiReady: (cb) => {
        apiSubs.add(cb)
        return () => apiSubs.delete(cb)
      },
      requestIdle: (cb) => {
        const entry = { cb, cancelled: false }
        idleQueue.push(entry)
        return () => {
          entry.cancelled = true
        }
      },
      preloadRoute,
      prefetchWorkspaceData: prefetchWorkspace
    },
    fireEmailReady: () => {
      emailReady = true
      for (const cb of [...emailSubs]) cb()
    },
    fireApiReady: () => {
      apiReady = true
      for (const cb of [...apiSubs]) cb()
    },
    flushIdle: () => {
      // 执行当前已排队的 (回调里可能再排新的, 快照遍历)。
      const batch = idleQueue.splice(0)
      for (const entry of batch) if (!entry.cancelled) entry.cb()
    },
    preloadRoute,
    prefetchWorkspace
  }
}

describe('startStartupPrefetch — 时序编排', () => {
  test('🔴 邮件列表 success 之前什么都不发 (api-ready 早到也不行)', () => {
    const h = makeHarness({ apiReadyNow: true }) // api-ready 先到
    startStartupPrefetch(h.io)
    h.flushIdle()
    expect(h.preloadRoute).not.toHaveBeenCalled()
    expect(h.prefetchWorkspace).not.toHaveBeenCalled()
    // 邮件落地后才走起
    h.fireEmailReady()
    h.flushIdle() // T1 idle
    expect(h.preloadRoute).toHaveBeenCalledWith('/matters')
    expect(h.preloadRoute).toHaveBeenCalledWith('/contacts')
    h.flushIdle() // T2 idle (apiReadyNow=true → 直接排下一个 idle)
    expect(h.prefetchWorkspace).toHaveBeenCalledTimes(1)
  })

  test('T1 只发 chunk; T2 数据等 api-ready + 第二次 idle', () => {
    const h = makeHarness()
    startStartupPrefetch(h.io)
    h.fireEmailReady()
    h.flushIdle() // T1
    expect(h.preloadRoute).toHaveBeenCalledTimes(2)
    expect(h.prefetchWorkspace).not.toHaveBeenCalled()
    // api 还没就绪 → 没有第二个 idle 排进来
    h.flushIdle()
    expect(h.prefetchWorkspace).not.toHaveBeenCalled()
    h.fireApiReady()
    h.flushIdle() // T2 idle
    expect(h.prefetchWorkspace).toHaveBeenCalledTimes(1)
  })

  test('挂载时邮件缓存已 success → 不等订阅直接进 T1', () => {
    const h = makeHarness({ emailReadyNow: true, apiReadyNow: true })
    startStartupPrefetch(h.io)
    h.flushIdle() // T1
    h.flushIdle() // T2
    expect(h.preloadRoute).toHaveBeenCalledTimes(2)
    expect(h.prefetchWorkspace).toHaveBeenCalledTimes(1)
  })

  test('dispose 后事件再来 / idle 再跑都熄火', () => {
    const h = makeHarness()
    const dispose = startStartupPrefetch(h.io)
    dispose()
    h.fireEmailReady()
    h.flushIdle()
    h.fireApiReady()
    h.flushIdle()
    expect(h.preloadRoute).not.toHaveBeenCalled()
    expect(h.prefetchWorkspace).not.toHaveBeenCalled()
  })

  test('T1 之后 dispose → T2 不再发', () => {
    const h = makeHarness({ apiReadyNow: false })
    const dispose = startStartupPrefetch(h.io)
    h.fireEmailReady()
    h.flushIdle() // T1 完成
    expect(h.preloadRoute).toHaveBeenCalledTimes(2)
    dispose()
    h.fireApiReady()
    h.flushIdle()
    expect(h.prefetchWorkspace).not.toHaveBeenCalled()
  })
})

describe('prefetchWorkspaceData — 与工作台读 key 同源', () => {
  function seededClient(flags: { mattersEnabled: boolean; contactsEnabled: boolean }): QueryClient {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(APP_CONFIG_QUERY_KEY, {
      mattersEnabled: flags.mattersEnabled,
      matterAgentEnabled: false,
      contactsEnabled: flags.contactsEnabled,
      contactAgentEnabled: false
    })
    return qc
  }

  test('两 flag 全开 → 事项列表 + 通讯录首页各预热一次, key 与页面 hook 逐字一致', async () => {
    const qc = seededClient({ mattersEnabled: true, contactsEnabled: true })
    await prefetchWorkspaceData(qc)
    expect(mockMatterList).toHaveBeenCalledTimes(1)
    expect(mockContactList).toHaveBeenCalledTimes(1)
    // key 同源断言: 与 MattersWorkspace liveList (qk.matters.list()) 一致。
    expect(qc.getQueryData(qk.matters.list())).toEqual({ items: [], total: 0 })
    // 与 ContactsWorkspace 的 useContactListPaged 一致: view 来自 lastVisit ('all'),
    // q 初值 '', sort 来自 listPrefs ('name') —— 三者都是 mock 出的非默认值,
    // 预热若回退到硬编码 ('known'/'density') 这里必红。
    const contactsCache = qc.getQueryData(qk.contacts.listPaged('all', '', 'name'))
    expect(contactsCache).toMatchObject({
      pages: [{ items: [], total: 0, next_cursor: null }]
    })
  })

  test('flag 关着的工作台不发请求', async () => {
    const qc = seededClient({ mattersEnabled: false, contactsEnabled: false })
    await prefetchWorkspaceData(qc)
    expect(mockMatterList).not.toHaveBeenCalled()
    expect(mockContactList).not.toHaveBeenCalled()
  })

  // 通知中心没有 flag（design §8.e）：两个工作台都关着也照样预热 —— 铃铛恒在。
  test('通知面板首屏无条件预热，key 与面板 hook 逐字一致', async () => {
    const qc = seededClient({ mattersEnabled: false, contactsEnabled: false })
    await prefetchWorkspaceData(qc)
    expect(mockNotificationList).toHaveBeenCalledTimes(1)
    // 参数同源：活跃态 + 50 条，**不带 category**（面板恒拉全类目一份，切 tab 本地过滤）。
    expect(mockNotificationList).toHaveBeenCalledWith({ state: 'open', limit: 50 })
    // key 同源断言：面板的 useNotificationList 读的就是这个 key，漂了就等于没预热。
    expect(qc.getQueryData(qk.notifications.list('open'))).toMatchObject({ items: [], total: 0 })
  })

  test('只开通讯录 → 只预热通讯录', async () => {
    const qc = seededClient({ mattersEnabled: false, contactsEnabled: true })
    await prefetchWorkspaceData(qc)
    expect(mockMatterList).not.toHaveBeenCalled()
    expect(mockContactList).toHaveBeenCalledTimes(1)
  })
})
