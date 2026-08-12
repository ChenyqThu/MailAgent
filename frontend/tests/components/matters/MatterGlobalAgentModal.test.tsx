// @vitest-environment happy-dom
//
// 0812 dogfood Lane C —— 全局配置弹窗「如实呈现」的渲染面。
//
// 叶子闸（tests/ai-gateway/matter_tool_face_leaf.test.ts）盯的是**清单内容**与真实工具面
// 是否一致；那道闸盯不住的是「清单有没有真的渲染出来」「i18n key 有没有落空」「保存失败
// 之后界面显示的档位有没有退回服务端事实」—— 后者正是本文件。
//
// 🔴 特别是回滚：一个"显示 X、实际存的是 Y"的安全开关比没有开关更危险，而它只在 PUT 失败
// 这条路径上出现，肉眼 dogfood 基本碰不到。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import { qk } from '@shared/lib/queryKeys'
import { MATTER_TOOL_FACE_STATIC_TOOLS } from '@shared/lib/matterToolFace'

const { connectorRows, chatConfig, toastError } = vi.hoisted(() => ({
  connectorRows: { value: [] as Array<Record<string, unknown>> },
  // /chat/config 的两个可用性信号（0812 Lane D）。默认 = 全开，于是既有用例的渲染一字不变。
  chatConfig: {
    value: {
      advertisedSkills: ['email', 'search', 'report'] as string[] | null,
      webToolsEnabled: true as boolean | undefined
    }
  },
  toastError: vi.fn()
}))

vi.mock('@shared/hooks/useConnectorQuickRows', () => ({
  useConnectorQuickRows: () => ({
    rows: connectorRows.value,
    available: connectorRows.value.length > 0,
    anyActive: connectorRows.value.length > 0
  })
}))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterGlobalAgentModal } = await import('@shared/components/matters/MatterGlobalAgentModal')

await i18n.changeLanguage('zh-CN')

/** 端点桩：文档 GET + 网页档 GET/PUT。PUT 的成败由 `putOk` 控制。 */
const putOk = { value: true }
const putCalls: Array<Record<string, unknown>> = []

function envelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data })
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  connectorRows.value = []
  chatConfig.value = {
    advertisedSkills: ['email', 'search', 'report'],
    webToolsEnabled: true
  }
  putOk.value = true
  putCalls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      if (url.includes('/agent/profile/docs/matter_agent')) {
        return envelope({ content: '', defaultContent: '【任务契约】默认全文' })
      }
      if (url.includes('/chat/config')) {
        return envelope(chatConfig.value)
      }
      if (url.includes('/agent/matter-web-face')) {
        if ((init?.method ?? 'GET') === 'PUT') {
          const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
          putCalls.push(body)
          if (!putOk.value) return { ok: false, status: 500 } as unknown as Response
          return envelope({ mode: body.mode })
        }
        return envelope({ mode: 'keep' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderModal(prime?: (client: QueryClient) => void): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `prime` 用来在渲染前把某个 query 置成「在途」——connector 的加载态判据是 react-query 的
  // 在途计数（组件不改 useConnectorQuickRows 的签名），只能这样才驱动得到那条分支。
  prime?.(client)
  render(
    <QueryClientProvider client={client}>
      <MatterGlobalAgentModal onClose={() => {}} />
    </QueryClientProvider>
  )
}

describe('MatterGlobalAgentModal —— 提示词分段 + 工具面清单 + 网页三档', () => {
  test('提示词五段与它们各自的来源都摆出来了（owner 才知道自己改的是哪一段）', async () => {
    renderModal()
    for (const name of ['任务契约', '本次跟进要做的事', '事项快照', '变化清单', '补充指引']) {
      expect(await screen.findAllByText(name)).not.toHaveLength(0)
    }
    // 三种来源标签都出现过（可改 / 运行时注入 / 事项级）—— i18n key 落空会在这里红。
    expect(screen.getAllByText('可改').length).toBeGreaterThan(0)
    expect(screen.getAllByText('运行时注入').length).toBeGreaterThan(0)
    expect(screen.getAllByText('事项级').length).toBeGreaterThan(0)
  })

  test('工具面清单默认展开、逐个工具名都在（不是折叠起来让人点）', async () => {
    renderModal()
    await screen.findByText('事项')
    for (const tool of MATTER_TOOL_FACE_STATIC_TOOLS) {
      expect(screen.getByText(tool), `${tool} 没被渲染出来`).toBeTruthy()
    }
  })

  test('一家外部服务都没连 → 如实说没有，不画假清单', async () => {
    renderModal()
    expect(await screen.findByText('未连接任何外部服务')).toBeTruthy()
  })

  test('连了服务 → 动态列出实际连上的那几家（未启用/未连接的行不算）', async () => {
    connectorRows.value = [
      { connector_id: 'notion', display_name: 'Notion', enabled: true, status: 'connected' },
      { connector_id: 'jira', display_name: 'Jira', enabled: true, status: 'needs_reauth' },
      { connector_id: 'slack', display_name: 'Slack', enabled: false, status: 'connected' }
    ]
    renderModal()
    expect(await screen.findByText('Notion')).toBeTruthy()
    expect(screen.queryByText('Jira')).toBeNull()
    expect(screen.queryByText('Slack')).toBeNull()
    expect(screen.queryByText('未连接任何外部服务')).toBeNull()
  })

  test('🔴 关掉某个 skill → 那一族标「已关闭」，但工具仍然列出来（不隐藏）', async () => {
    chatConfig.value = { advertisedSkills: ['search', 'report'], webToolsEnabled: true }
    renderModal()
    // owner 明说「就算不可改也应该列出来」：降级 ≠ 隐藏。
    expect(await screen.findByText('email_get')).toBeTruthy()
    const badges = await screen.findAllByText('已关闭')
    // 只有 email 那一组该标 —— search / report 仍 advertised，core 组永不受影响。
    expect(badges).toHaveLength(1)
    expect(
      screen.getByText(/设置 → Custom AI → Skills/),
      '标了「已关闭」却不说去哪儿开 = 只把问题从"不知道"换成"不知道怎么办"'
    ).toBeTruthy()
  })

  test('advertisedSkills 没下发（后端打嗝）→ 一个「已关闭」都不出（fail-open，与 gateway 同侧）', async () => {
    chatConfig.value = { advertisedSkills: null, webToolsEnabled: true }
    renderModal()
    await screen.findByText('email_get')
    expect(screen.queryByText('已关闭'), '把"还不知道"显示成"关了"是另一个方向的谎').toBeNull()
  })

  test('🔴 web 工具未启用 → 三档全禁用 + 说明为什么（不做假开关）', async () => {
    chatConfig.value = { advertisedSkills: ['email', 'search', 'report'], webToolsEnabled: false }
    renderModal()
    const options = await screen.findAllByRole('radio')
    // 先等档位读回来 —— 否则 disabled 可能只是"还没加载"，测不到我们要测的那个原因。
    await waitFor(() => expect(options[0].getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(screen.getByText('不可用')).toBeTruthy())
    for (const option of options) {
      expect((option as HTMLButtonElement).disabled, '存了也没有消费者的开关不该可点').toBe(true)
    }
    expect(screen.getByText(/MAILAGENT_OPENNESS_WEB_TOOLS/)).toBeTruthy()
  })

  test('🔴 connector 还在读的时候不许先断言「未连接」', async () => {
    renderModal((client) => {
      // 永不 resolve → 该 query 恒在途，正是「数据还没回来」的那一刻。
      void client.prefetchQuery({
        queryKey: qk.connectors(),
        queryFn: () => new Promise<never>(() => {})
      })
    })
    expect(await screen.findByText('正在读取已连接的外部服务…')).toBeTruthy()
    expect(screen.queryByText('未连接任何外部服务')).toBeNull()
  })

  test('网页三档：当前档来自服务端，点另一档 PUT 回去', async () => {
    renderModal()
    const options = await screen.findAllByRole('radio')
    expect(options).toHaveLength(3)
    await waitFor(() => expect(options[0].getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(options[1])
    await waitFor(() => expect(putCalls).toEqual([{ mode: 'search_only' }]))
    await waitFor(() => expect(options[1].getAttribute('aria-checked')).toBe('true'))
  })

  test('🔴 保存失败 → toast 报错 + 显示的档位退回服务端事实（不留一个没存进去的值）', async () => {
    putOk.value = false
    renderModal()
    const options = await screen.findAllByRole('radio')
    await waitFor(() => expect(options[0].getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(options[2]) // 关闭
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // 回滚：仍显示服务端那一档，而不是刚点的「关闭」
    expect(options[2].getAttribute('aria-checked')).toBe('false')
    expect(options[0].getAttribute('aria-checked')).toBe('true')
  })
})
