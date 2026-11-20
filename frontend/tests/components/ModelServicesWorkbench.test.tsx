// @vitest-environment happy-dom
//
// Phase 1 — Magpie-grade Master-Detail Provider Workbench + AddProviderDialog + Rich ModelSelect.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { ModelSelect } from '@shared/components/providers/ModelSelect'
import { ModelServicesSection } from '@shared/components/settings/providers/ModelServicesSection'
import type { LlmProviderSummary } from '@shared/hooks/useLlmProviders'

vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

const mockFetchCalls: Array<{ url: string; method: string; body?: unknown }> = []

const PROVIDERS: LlmProviderSummary[] = [
  {
    id: 'default',
    protocol: 'anthropic',
    displayName: 'Anthropic 主网关',
    baseUrl: 'https://api.anthropic.com',
    headerNames: ['X-Secret-A', 'X-Secret-B'],
    enabled: true,
    sortOrder: 0,
    hasKey: true,
    keyLast4: '1234',
    keyCount: 2,
    extraKeyLast4s: ['5678'],
    customIcon: null,
    enabledModelCount: 1,
    totalModelCount: 2,
    isDefault: true,
    createdAt: 1000,
    updatedAt: 1000
  },
  {
    id: 'dashscope',
    protocol: 'openai-compatible',
    displayName: '通义千问中转',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    headerNames: [],
    enabled: true,
    sortOrder: 1,
    hasKey: true,
    keyLast4: '9999',
    keyCount: 1,
    extraKeyLast4s: [],
    customIcon: null,
    enabledModelCount: 1,
    totalModelCount: 1,
    isDefault: false,
    createdAt: 1001,
    updatedAt: 1001
  }
]

const stubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  mockFetchCalls.push({ url, method, body })

  let data: unknown = {}
  if (url.endsWith('/llm/providers') && method === 'GET') {
    data = { providers: PROVIDERS, version: 1 }
  } else if (url.includes('/models') && method === 'GET') {
    data = {
      provider: url.includes('/dashscope/') ? 'dashscope' : 'default',
      models: url.includes('/dashscope/')
        ? [
            {
              id: 'qwen-max',
              displayName: null,
              groupName: null,
              enabled: true,
              capabilities: null,
              maxOutput: null,
              contextWindow: null,
              source: 'manual',
              fetchedAt: null
            }
          ]
        : [
            {
              id: 'claude-sonnet-4-6',
              displayName: null,
              groupName: null,
              enabled: true,
              capabilities: null,
              maxOutput: null,
              contextWindow: null,
              source: 'fetched',
              fetchedAt: null
            }
          ],
      fetchedNew: 0,
      error: null
    }
  } else if (url.endsWith('/llm/providers/probe')) {
    data = { ok: true, latencyMs: 42, error: null }
  } else if (method === 'PATCH') {
    data = { ...PROVIDERS[0], headerNames: ['X-Secret-B'] }
  }

  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 'success', data }),
    json: async () => ({ status: 'success', data })
  } as unknown as Response
})

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  vi.stubGlobal('fetch', stubFetch)
})

afterEach(() => {
  cleanup()
  mockFetchCalls.length = 0
  stubFetch.mockClear()
})

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('ModelServicesSection 纵向列表 + 配置弹窗工作台', () => {
  test('纵向列表打开配置弹窗 + 连接与安全 Tab 增量删除 Header + 多 Key 池提交', async () => {
    wrap(<ModelServicesSection />)

    // 纵向列表渲染两家 provider，默认未弹窗
    expect(await screen.findByText('Anthropic 主网关')).toBeTruthy()
    expect(screen.getByText('通义千问中转')).toBeTruthy()

    // 点开第一家 provider 的配置弹窗并切换到「连接与安全」
    fireEvent.click(screen.getByLabelText('配置 Anthropic 主网关'))
    const dialog1 = await screen.findByRole('dialog')
    fireEvent.click(within(dialog1).getByRole('tab', { name: '连接与安全' }))

    expect(within(dialog1).getByDisplayValue('https://api.anthropic.com')).toBeTruthy()
    expect(within(dialog1).getByText('X-Secret-A')).toBeTruthy()
    expect(within(dialog1).getByText('X-Secret-B')).toBeTruthy()

    // 单击删除 X-Secret-A → PATCH headerPatch { 'X-Secret-A': null }（无需重填 X-Secret-B）
    fireEvent.click(within(dialog1).getByLabelText('删除 header X-Secret-A'))
    await waitFor(() => {
      const patchCall = mockFetchCalls.find(
        (c) => c.method === 'PATCH' && c.url.includes('/llm/providers/default')
      )
      expect(patchCall?.body).toEqual({ headerPatch: { 'X-Secret-A': null } })
    })

    // 修改备用 Key 池并点击保存 → PATCH extraApiKeys
    const poolTextarea = within(dialog1).getByPlaceholderText(/每行一个备用 Key/)
    fireEvent.change(poolTextarea, { target: { value: 'sk-spare-1\nsk-spare-2' } })
    fireEvent.click(within(dialog1).getByText('保存备用池'))
    await waitFor(() => {
      const poolPatch = mockFetchCalls.find(
        (c) =>
          c.method === 'PATCH' &&
          (c.body as { extraApiKeys?: string[] } | undefined)?.extraApiKeys !== undefined
      )
      expect(poolPatch?.body).toEqual({ extraApiKeys: ['sk-spare-1', 'sk-spare-2'] })
    })

    // 关闭第一个弹窗 → 点开第二家 provider → 切换到连接与安全检查 API 地址
    fireEvent.click(within(dialog1).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByLabelText('配置 通义千问中转'))
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(within(dialog2).getByRole('tab', { name: '连接与安全' }))
    expect(
      await within(dialog2).findByDisplayValue('https://dashscope.aliyuncs.com/compatible-mode/v1')
    ).toBeTruthy()
  })

  test('AddProviderDialog 本地模板选择 + 先测后存 (/probe)', async () => {
    wrap(<ModelServicesSection />)
    await screen.findByText('Anthropic 主网关')

    fireEvent.click(screen.getAllByText('添加')[0])
    expect(await screen.findByText('添加服务商')).toBeTruthy()

    // 切换到「本地」分类，选 Ollama（本地）
    fireEvent.click(screen.getByText('本地'))
    fireEvent.click(screen.getByText('Ollama（本地）'))

    fireEvent.click(within(screen.getByRole('dialog')).getByText('测试连接'))
    await waitFor(() => {
      const probe = mockFetchCalls.find((c) => c.url.endsWith('/llm/providers/probe'))
      expect(probe?.body).toMatchObject({
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1'
      })
    })
    expect(await screen.findByText('连接正常（42ms）')).toBeTruthy()
  })
})

describe('ModelSelect 富模型选择器', () => {
  test('按人类 provider.displayName 分组 + 搜索过滤 + 回传完整 providerRef', () => {
    const onChange = vi.fn()
    const models = [
      'claude-sonnet-4-6',
      'dashscope:qwen-max',
      'dashscope:m2',
      'dashscope:m3',
      'dashscope:m4',
      'dashscope:m5',
      'dashscope:m6',
      'dashscope:m7'
    ]
    wrap(
      <ModelSelect
        value="claude-sonnet-4-6"
        onValueChange={onChange}
        models={models}
        providers={PROVIDERS}
        ariaLabel="选择模型"
      />
    )

    fireEvent.click(screen.getByLabelText('选择模型'))
    // 人类名称组标题而非裸 slug 'dashscope'
    expect(screen.getByText('通义千问中转')).toBeTruthy()
    expect(screen.getByText('Anthropic 主网关')).toBeTruthy()

    // >=8 个模型自动展示搜索框并可过滤（按 wire id 搜 'qwen-max'，命中目录显示名 Qwen Max）
    const searchInput = screen.getByPlaceholderText('搜索模型或服务商…')
    fireEvent.change(searchInput, { target: { value: 'qwen-max' } })
    fireEvent.click(screen.getByText(/Qwen/i))
    expect(onChange).toHaveBeenCalledWith('dashscope:qwen-max')
  })
})
