// @vitest-environment happy-dom
//
// 速赢包 §4 —— 工作台 flag 的启动竞态修复。
//
// 覆盖三条（都是这次真正改掉的行为，不是配置复述）：
//   1. 事项 / 通讯录两个 flag hook 同挂 → `/chat/config` 只发一次（此前两个 queryKey
//      各发一次，正撞 serve-api 最没起来的一瞬）；
//   2. 🔴 拉不到 = 抛错，**不再**吞成 `{enabled:false}`。旧写法对 react-query 是一次
//      成功响应，"后端还没起" 被当事实缓存住 → 事项/通讯录渲染成「已禁用」空态；
//   3. main 广播 `mailagent:api-ready` → renderer 失效三族 serve-api query；卸载时
//      解除监听（本仓有 subscribe 不 dispose → listener 泄漏的前科）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { fetchAppConfigFlags, APP_CONFIG_QUERY_KEY } from '@shared/hooks/useAppConfig'
import { useApiReadyRefresh } from '@shared/hooks/useApiReadyRefresh'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'
import { useMatterFlags } from '@shared/components/matters/hooks'
import { useContactFlags } from '@shared/components/contacts/hooks'
import { qk } from '@shared/lib/queryKeys'

const CONFIG_BODY = {
  status: 'success',
  data: {
    mattersEnabled: true,
    matterAgentEnabled: true,
    contactsEnabled: true,
    contactAgentEnabled: true
  }
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => CONFIG_BODY
  } as unknown as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useAppConfig — 事项 / 通讯录共享同一次 /chat/config', () => {
  test('两个 flag hook 同挂只发一次请求，且各自投影到原来的形状', async () => {
    // 形参显式带上 input：`vi.fn(async () => …)` 推出的 calls 是空元组 `[]`,
    // 下面按 `[input]` 解构会 TS2493（typecheck:tests 目标会红）。
    const mockFetch = vi.fn(async (_input: RequestInfo | URL) => okResponse())
    vi.stubGlobal('fetch', mockFetch)

    function Probe(): React.ReactElement {
      const { mattersEnabled, matterAgentEnabled } = useMatterFlags()
      const { contactsEnabled, contactAgentEnabled } = useContactFlags()
      return (
        <div
          data-testid="probe"
          data-matters={String(mattersEnabled)}
          data-matter-agent={String(matterAgentEnabled)}
          data-contacts={String(contactsEnabled)}
          data-contact-agent={String(contactAgentEnabled)}
        />
      )
    }

    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>
    )

    await vi.waitFor(() =>
      expect(screen.getByTestId('probe').getAttribute('data-contacts')).toBe('true')
    )
    const probe = screen.getByTestId('probe')
    expect(probe.getAttribute('data-matters')).toBe('true')
    expect(probe.getAttribute('data-matter-agent')).toBe('true')
    expect(probe.getAttribute('data-contact-agent')).toBe('true')
    const configCalls = mockFetch.mock.calls.filter(([input]) =>
      String(input).includes('/chat/config')
    )
    expect(configCalls).toHaveLength(1)
  })
})

describe('fetchAppConfigFlags — 失败即抛（启动竞态的命脉）', () => {
  test('HTTP 非 2xx → reject（不返回 all-off 默认值）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response)
    )
    await expect(fetchAppConfigFlags()).rejects.toThrow('HTTP 503')
  })

  test('连接被拒（serve-api 还没 bind）→ reject', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    await expect(fetchAppConfigFlags()).rejects.toThrow()
  })

  test('响应 ok → 四个 flag 按 === true 投影（缺字段视为关）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ data: { mattersEnabled: true, contactsEnabled: 'yes' } })
          }) as unknown as Response
      )
    )
    await expect(fetchAppConfigFlags()).resolves.toEqual({
      mattersEnabled: true,
      matterAgentEnabled: false,
      contactsEnabled: false,
      contactAgentEnabled: false
    })
  })
})

describe('useApiReadyRefresh — serve-api 就绪广播的落点', () => {
  test('收到 mailagent:api-ready → 失效 flag / 事项 / 通讯录三族；卸载时解除监听', () => {
    let captured: ((...args: unknown[]) => void) | null = null
    const dispose = vi.fn()
    const on = vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
      if (channel === API_READY_CHANNEL) captured = fn
      return dispose
    })
    vi.stubGlobal('window', Object.assign(window, { electron: { ipcRenderer: { on } } }))

    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    function Mount(): null {
      useApiReadyRefresh()
      return null
    }
    const view = render(
      <QueryClientProvider client={qc}>
        <Mount />
      </QueryClientProvider>
    )

    expect(captured).not.toBeNull()
    captured!()
    const keys = invalidate.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey)
    expect(keys).toEqual([APP_CONFIG_QUERY_KEY, qk.matters.all(), qk.contacts.all()])

    view.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
