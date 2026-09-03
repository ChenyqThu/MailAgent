// @vitest-environment happy-dom

// 通知面板加载体验的两条**请求级**行为（其余交互在 NotificationPanel.test.tsx，那边把
// `./hooks` 整块 mock 掉了，看不见请求）：
//   ① 切 tab 全程只发一次列表请求 —— tab 过滤在前端做，5 个 tab 共用一份缓存。
//      回退形状（category 进 queryKey）在这里表现为「点一次 tab 多一次请求」。
//   ② 启动预热放好的缓存能被面板首挂直接命中 —— 首帧就是内容，不闪骨架、不发请求。
//      key 漂了（预热写 A、面板读 B）在这里表现为「首帧还是骨架」。
//
// 数据层用真 hooks + 真 QueryClient，只 mock 到 REST client 那一层（`api/notifications`）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '../../src/shared/i18n'
import { qk } from '../../src/shared/lib/queryKeys'
import { refreshNotifications } from '../../src/shared/components/notifications/notificationMutation'
import type { NotificationItem } from '../../src/shared/api/types/notifications'

const NOW = new Date(2026, 7, 21, 14, 30).getTime()

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  unreadCount: vi.fn(),
  navigate: vi.fn(),
  // `library` 型落地借道 `router.history.push`（见 NotificationPanel.tsx 里的
  // `useRouter` 调用）——这个文件不测那条分支，只需要一个不炸的桩。
  historyPush: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => hoisted.navigate,
  useRouter: () => ({ history: { push: hoisted.historyPush } })
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ updater: { quitAndInstall: vi.fn() } })
}))
vi.mock('@shared/api/notifications', () => ({
  createNotificationsApi: () => ({
    list: hoisted.list,
    unreadCount: hoisted.unreadCount,
    readAll: vi.fn(),
    markRead: vi.fn(),
    snooze: vi.fn(),
    resolve: vi.fn()
  })
}))

const { NotificationPanel } =
  await import('../../src/shared/components/notifications/NotificationPanel')

await i18n.changeLanguage('zh-CN')

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: 1,
  category: 'results',
  source: 'report',
  severity: 'info',
  state: 'open',
  title: '日报已生成',
  body: '',
  payload: null,
  recurrenceNo: 1,
  firstCreatedAt: NOW - 60_000,
  lastEventAt: NOW - 60_000,
  readAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  dismissedAt: null,
  ...over
})

const listResult = (
  items: NotificationItem[]
): { items: NotificationItem[]; total: number; unread: number; limit: number; offset: number } => ({
  items,
  total: items.length,
  unread: items.length,
  limit: 50,
  offset: 0
})

const ITEMS = [
  item({ id: 1, category: 'results', title: '日报已生成' }),
  item({ id: 2, category: 'action_required', title: '有一条审批待处理' })
]

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderPanel(client: QueryClient): void {
  render(
    <QueryClientProvider client={client}>
      <NotificationPanel onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.list.mockResolvedValue(listResult(ITEMS))
  hoisted.unreadCount.mockResolvedValue({
    total: 2,
    byCategory: { action_required: 1, reviews: 0, results: 1, system: 0 },
    bySeverity: { info: 2, warn: 0, critical: 0 },
    openByCategory: { action_required: 1, reviews: 0, results: 1, system: 0 }
  })
})

afterEach(cleanup)

describe('通知面板的列表请求', () => {
  test('切 tab 不发第二次请求（一份数据喂五个 tab）', async () => {
    renderPanel(makeClient())
    expect(await screen.findByText('日报已生成')).toBeTruthy()
    expect(hoisted.list).toHaveBeenCalledTimes(1)
    expect(hoisted.list).toHaveBeenCalledWith({ state: 'open', limit: 50 })

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.getByText('有一条审批待处理')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    fireEvent.click(screen.getByRole('tab', { name: '全部' }))

    expect(hoisted.list).toHaveBeenCalledTimes(1)
  })

  test('预热过的缓存 → 首帧就是内容（不闪骨架、不发请求）', () => {
    const client = makeClient()
    // 启动预热 (startupPrefetch T2) 写进去的那一份，逐字同 key。
    client.setQueryData(qk.notifications.list('open'), listResult(ITEMS))

    renderPanel(client)

    expect(screen.queryByTestId('notification-list-skeleton')).toBeNull()
    expect(screen.getByText('日报已生成')).toBeTruthy()
    expect(hoisted.list).not.toHaveBeenCalled()
  })

  test('没有预热 → 首帧是骨架', () => {
    renderPanel(makeClient())
    expect(screen.getByTestId('notification-list-skeleton')).toBeTruthy()
  })

  // 历史（已处理）视图：独立 key + enabled 只在历史态。回退形状（与活跃列表共用一条
  // 查询 / 共用一个 key）在这里表现为「进历史把 open 那份缓存冲掉」——切回来会再取一次。
  test('进历史才拉 resolved，且不冲掉 open 那份缓存', async () => {
    const client = makeClient()
    renderPanel(client)
    expect(await screen.findByText('日报已生成')).toBeTruthy()
    expect(hoisted.list).toHaveBeenCalledTimes(1)
    expect(hoisted.list).toHaveBeenCalledWith({ state: 'open', limit: 50 })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '已处理' }))
    })
    expect(hoisted.list).toHaveBeenCalledTimes(2)
    expect(hoisted.list).toHaveBeenLastCalledWith({ state: 'resolved', limit: 50 })
    expect(client.getQueryData(qk.notifications.list('open'))).toBeTruthy()

    // 切回活跃：那份缓存还在（staleTime 4s 内）⇒ 不再发第三次请求。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '返回' }))
    })
    expect(screen.getByText('日报已生成')).toBeTruthy()
    expect(hoisted.list).toHaveBeenCalledTimes(2)
  })

  // key 形状改过（category 出 key）之后，失效前缀是否还罩得住这条查询 —— 罩不住的表现是
  // 「SSE 来了 / 标了已读，面板纹丝不动」，而不会有任何类型错误。
  test('refreshNotifications 的前缀失效仍然覆盖列表查询', async () => {
    const client = makeClient()
    renderPanel(client)
    expect(await screen.findByText('日报已生成')).toBeTruthy()
    expect(hoisted.list).toHaveBeenCalledTimes(1)

    await act(async () => {
      await refreshNotifications(client)
    })
    expect(hoisted.list).toHaveBeenCalledTimes(2)
  })
})
