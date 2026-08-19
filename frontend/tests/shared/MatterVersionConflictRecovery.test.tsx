// @vitest-environment happy-dom

/**
 * 0812 dogfood P0 复现：「不管点哪个都是 matter version changed，完全无法操作」。
 *
 * 病根不是「会发生版本冲突」（那是乐观锁的正常工作），而是**冲突之后 UI 永不自愈**：
 * 上下文页那几个 mutation 的 `expectedVersion` 取自渲染时那份 `matter.version`，而它们的
 * `onError` 只弹 toast、不刷新任何 query ⇒ 只要发生过**一次**冲突（后台 agent 在写 /
 * 用户连点两下），手里的 version 就永远停在旧值 ⇒ **之后每一次点击都必定失败**。
 *
 * 所以复现的判据是「第二次点击」而不是「第一次失败」：这个测试跑一个真实序列 ——
 * ① 页面按 version 3 渲染 → ② 后台把服务端推到 4 → ③ 第一次点确认（带 3）必然 409
 * → ④ **不做任何页面刷新**，直接再点一次。修复前第二次仍带 3、仍 409（卡死）；
 * 修复后第一次失败时统一出口已经把 matter 查询失效，第二次带 4 成功。
 *
 * 🔴 harness 自己持 `qk.matters.detail` 查询、把 matter 当 prop 往下传 —— 这正是
 * MatterDetail 的数据流。少了这一层就只能测到「onError 被调用」，测不到「自愈」。
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

import type { Matter, MatterResourceListItem } from '../../src/shared/api/types/matter'
import { qk } from '../../src/shared/lib/queryKeys'
import i18n from '../../src/shared/i18n'
import { useMattersApi } from '../../src/shared/components/matters/hooks'
import { useMatterMutation } from '../../src/shared/components/matters/matterMutation'
import { MatterSuggestedResourceActions } from '../../src/shared/components/matters/MatterSuggestedResourceActions'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const MATTER_ID = 'MAT-0042'

interface ServerState {
  /** 服务端当前版本（后台 agent 写入会推进它）。 */
  version: number
  /** 每次 PATCH 收到的 expected_version，按顺序。 */
  patchVersions: number[]
  /** reject-suggestion 收到的 expected_version。 */
  rejectVersions: number[]
  patchOk: number
}

function stubServer(initialVersion: number): ServerState {
  const state: ServerState = {
    version: initialVersion,
    patchVersions: [],
    rejectVersions: [],
    patchOk: 0
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/reject-suggestion')) {
        const body = JSON.parse(String(init?.body)) as { mutation: { expected_version: number } }
        state.rejectVersions.push(body.mutation.expected_version)
        return json(
          {
            status: 'error',
            schema_version: 1,
            error: { code: 'E_VERSION_CONFLICT', message: 'matter version changed' }
          },
          409
        )
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { mutation: { expected_version: number } }
        const expected = body.mutation.expected_version
        state.patchVersions.push(expected)
        if (expected !== state.version) {
          return json(
            {
              status: 'error',
              schema_version: 1,
              error: { code: 'E_VERSION_CONFLICT', message: 'matter version changed' }
            },
            409
          )
        }
        state.version += 1
        state.patchOk += 1
        return json({
          status: 'success',
          schema_version: 1,
          data: { matter: matter(state.version) }
        })
      }
      if (url.includes(`/matters/${MATTER_ID}`)) {
        return json({
          status: 'success',
          schema_version: 1,
          data: { matter: matter(state.version), items: [], timeline: [] }
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
  )
  return state
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** 复刻 MatterDetail 的数据流：查询持有 matter，组件拿到的是 prop。 */
function Harness({ item }: { item: MatterResourceListItem }): React.ReactElement {
  const api = useMattersApi()
  const detail = useQuery({
    queryKey: qk.matters.detail(MATTER_ID),
    queryFn: () => api.get(MATTER_ID, ['items', 'timeline'])
  })
  const current = detail.data?.matter
  if (!current) return <div>loading</div>
  return (
    <div>
      <span data-testid="version">{current.version}</span>
      <MatterSuggestedResourceActions matter={current} item={item} onChanged={() => undefined} />
    </div>
  )
}

describe('matter 版本冲突后的自愈', () => {
  test('第一次冲突之后，再点一次仍然能用最新版本提交（不刷新整页）', async () => {
    const server = stubServer(3)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <Harness item={suggestedResource()} />
      </QueryClientProvider>
    )

    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('3'))

    // 后台跟进 Agent 写了一轮 —— 服务端到 4，页面手里还是 3。
    server.version = 4

    fireEvent.click(screen.getByRole('button', { name: /确认关联/ }))
    await waitFor(() => expect(server.patchVersions).toEqual([3]))

    // 🔴 这里**不做任何刷新**：修复前 UI 永远停在 3，第二次点击照样 409。
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('4'))

    fireEvent.click(screen.getByRole('button', { name: /确认关联/ }))
    await waitFor(() => expect(server.patchOk).toBe(1))
    expect(server.patchVersions).toEqual([3, 4])
  })

  test('「不相关」走的是同一条自愈路径（四处里另一处）', async () => {
    const server = stubServer(3)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <Harness item={suggestedResource()} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('3'))
    server.version = 4

    fireEvent.click(screen.getByRole('button', { name: /不相关/ }))
    await waitFor(() => expect(server.rejectVersions).toEqual([3]))
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('4'))
  })

  test('调用方自己的 onError 关不掉重新拉取', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const swallow = vi.fn()
    const { result } = renderHook(
      () =>
        useMatterMutation({
          matterId: MATTER_ID,
          mutationFn: async () => {
            throw conflictError()
          },
          // 最坏的调用方：自己吞掉错误、什么都不刷。
          onError: swallow
        }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        )
      }
    )

    result.current.mutate()

    await waitFor(() => expect(swallow).toHaveBeenCalledTimes(1))
    expect(
      invalidate.mock.calls.some(
        (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(qk.matters.detail(MATTER_ID))
      )
    ).toBe(true)
  })
})

function conflictError(): Error {
  return Object.assign(new Error('matter version changed'), { code: 'E_VERSION_CONFLICT' })
}

function matter(version: number): Matter {
  return {
    id: 42,
    public_id: MATTER_ID,
    title: 'Vendor launch',
    background: '',
    goal: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'on_track',
    priority: 'p1',
    owner_id: null,
    source: 'desktop_ui',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: 1,
    updated_at: 1
  }
}

function suggestedResource(): MatterResourceListItem {
  return {
    resource: {
      id: 7,
      kind: 'email',
      provider: 'mailagent',
      external_key: 'email:7',
      canonical_url: null,
      title: 'Suggested vendor email',
      metadata: {},
      revision: null,
      content_hash: null,
      permission_state: null,
      sync_state: null,
      access_policy: 'allowed',
      last_checked_at: null,
      created_at: 1,
      updated_at: 1,
      available: true
    },
    link: {
      id: 7,
      matter_id: 42,
      resource_id: 7,
      relation_type: null,
      pinned: false,
      added_by_kind: 'agent',
      added_by_id: null,
      confidence: 0.76,
      provenance: { reason: '同一会话中的近期回复' },
      confirmed_at: null,
      sub_state: 'none',
      deleted_at: null,
      created_at: 1,
      updated_at: 1
    }
  }
}
