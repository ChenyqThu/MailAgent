// @vitest-environment happy-dom
//
// ModelServicesSection — Settings「模型服务」区（task 07-12 P3）unit tests.
//
// 覆盖：
//   1. provider 列表渲染（displayName + protocol 徽标 + default 徽标；default 无删除钮）
//   2. 添加流：模板预填 → POST body（protocol/baseUrl 来自模板）
//   3. secret 掩码：apiKey 输入 placeholder 只见 hasKey+last4，新值 blur → PATCH 后清空，
//      明文不残留 DOM
//   4. 连通性测试：ok → 「连接正常（{ms}ms）」；error → 可读文案
//   5. 模型管理：启用勾选 → PUT {id, enabled}；拉取 → GET ?refresh=true
//
// 纯 UI 测试（raw fetch 全局 stub 按 URL 路由）；i18n 真实 zh-CN 资源（spec i18n.md）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import i18n from '@shared/i18n'
import { ModelServicesSection } from '../../src/shared/components/settings/providers/ModelServicesSection'

await i18n.changeLanguage('zh-CN')

// ---------------------------------------------------------------------------
// fetch 路由 stub（envelope 契约同 serve-api：{status:'success', data}）
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; body: unknown }
const calls: Call[] = []

const DEFAULT_PROVIDER = {
  id: 'default',
  protocol: 'anthropic',
  displayName: 'CRS',
  baseUrl: 'https://crs.example.com/api',
  // HIGH-1: header 值 write-only —— 列表投影只回名。
  headerNames: ['X-Gw-Sign'],
  enabled: true,
  sortOrder: 0,
  hasKey: true,
  keyLast4: '1234',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1
}
const DASH_PROVIDER = {
  ...DEFAULT_PROVIDER,
  id: 'dash',
  protocol: 'openai-compatible',
  displayName: 'Qwen',
  baseUrl: 'https://d/v1',
  hasKey: false,
  keyLast4: null,
  isDefault: false
}

let testResult: { ok: boolean; latencyMs: number; error: string | null } = {
  ok: true,
  latencyMs: 123,
  error: null
}

function envelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    // request() 消费 text()；/chat/config 的 flag/enabledModels 探针消费 json()。
    text: async () => JSON.stringify({ status: 'success', data }),
    json: async () => ({ status: 'success', data })
  } as unknown as Response
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ method, url, body })
  if (url.includes('/llm/providers') && url.includes('/models')) {
    if (method === 'PUT') {
      return envelope({
        id: body.id,
        displayName: null,
        groupName: null,
        enabled: body.enabled ?? true,
        capabilities: null,
        maxOutput: null,
        source: 'manual',
        fetchedAt: null
      })
    }
    return envelope({
      provider: 'default',
      models: [
        {
          id: 'claude-sonnet-4-6',
          displayName: null,
          groupName: null,
          enabled: true,
          capabilities: null,
          maxOutput: null,
          source: 'manual',
          fetchedAt: null
        }
      ],
      fetchedNew: 0,
      error: null
    })
  }
  if (url.includes('/llm/providers') && method === 'POST' && url.endsWith('/test')) {
    return envelope(testResult)
  }
  if (url.includes('/llm/providers') && method === 'POST') {
    return envelope({ ...DASH_PROVIDER, ...body })
  }
  if (url.includes('/llm/providers') && method === 'PATCH') {
    return envelope({ ...DEFAULT_PROVIDER, ...body })
  }
  if (url.includes('/llm/providers')) {
    return envelope({ providers: [DEFAULT_PROVIDER, DASH_PROVIDER], version: 1 })
  }
  if (url.includes('/chat/config')) {
    return envelope({ providerRegistryEnabled: true, enabledModels: [] })
  }
  return envelope({})
})
vi.stubGlobal('fetch', mockFetch)

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ModelServicesSection))
  )
}

beforeEach(() => {
  calls.length = 0
  testResult = { ok: true, latencyMs: 123, error: null }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function expandDefault(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('展开 CRS'))
}

describe('ModelServicesSection — 列表', () => {
  test('渲染 provider 行：名称 + protocol 徽标 + default 徽标；default 行无删除钮', async () => {
    renderUi()
    expect(await screen.findByText('CRS')).toBeTruthy()
    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.getByText('anthropic')).toBeTruthy()
    expect(screen.getByText('默认')).toBeTruthy()
    // default 禁删：只有非 default 行有删除钮
    expect(screen.queryByLabelText('删除 CRS')).toBeNull()
    expect(screen.getByLabelText('删除 Qwen')).toBeTruthy()
  })
})

describe('ModelServicesSection — 添加流', () => {
  test('模板预填 protocol/baseUrl，创建 → POST body 对齐模板', async () => {
    renderUi()
    await screen.findByText('CRS')
    fireEvent.click(screen.getByText('添加'))
    // 默认选中首个模板（Anthropic 官方）：id 预填 'anthropic'，baseUrl 空 = 官方默认
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && !c.url.endsWith('/test'))
      expect(post).toBeTruthy()
      expect(post!.body).toMatchObject({
        id: 'anthropic',
        protocol: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: ''
      })
      // 未填 key → body 不携带 apiKey 键
      expect('apiKey' in (post!.body as Record<string, unknown>)).toBe(false)
    })
  })
})

describe('ModelServicesSection — secret 掩码', () => {
  test('placeholder 只见掩码（····1234），新值 blur → PATCH 且输入清空、明文不残留', async () => {
    renderUi()
    await expandDefault()
    const input = screen.getByPlaceholderText(/····1234/) as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk-new-secret' } })
    fireEvent.blur(input)
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ apiKey: 'sk-new-secret' })
    })
    expect(input.value).toBe('')
    expect(document.body.textContent).not.toContain('sk-new-secret')
  })
})

describe('ModelServicesSection — 连通性测试', () => {
  test('ok → 展示「连接正常（123ms）」', async () => {
    renderUi()
    await expandDefault()
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }))
    expect(await screen.findByText('连接正常（123ms）')).toBeTruthy()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/test'))).toBe(true)
  })

  test('错误 key → 展示后端可读报错', async () => {
    testResult = {
      ok: false,
      latencyMs: 45,
      error: 'authentication failed (HTTP 401) — check the API key'
    }
    renderUi()
    await expandDefault()
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }))
    expect(await screen.findByText(/authentication failed \(HTTP 401\)/)).toBeTruthy()
  })
})

describe('ModelServicesSection — 模型管理', () => {
  test('启用勾选 → PUT {id, enabled:false}', async () => {
    renderUi()
    await expandDefault()
    const checkbox = await screen.findByLabelText('claude-sonnet-4-6')
    fireEvent.click(checkbox)
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      expect(put!.body).toEqual({ id: 'claude-sonnet-4-6', enabled: false })
    })
  })

  test('拉取模型列表 → POST /models/refresh（HIGH-2 后独立写端点，GET 纯读）', async () => {
    renderUi()
    await expandDefault()
    fireEvent.click(await screen.findByText('拉取模型列表'))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/models/refresh'))).toBe(true)
    })
    // GET 面不再携带 refresh 参数（读端点不出网不写库）。
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('refresh='))).toBe(false)
  })
})

describe('ModelServicesSection — headers write-only（HIGH-1）', () => {
  test('已存 header 只显名 + •••• 占位，值不回显；输入新值保存 → PATCH 全量明文 map', async () => {
    renderUi()
    await expandDefault()
    const input = (await screen.findByLabelText('X-Gw-Sign')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••')

    fireEvent.change(input, { target: { value: 'gw-secret-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ headers: { 'X-Gw-Sign': 'gw-secret-2' } })
    })
    // 保存成功后明文草稿清空、不残留 DOM。
    await waitFor(() => {
      expect((screen.getByLabelText('X-Gw-Sign') as HTMLInputElement).value).toBe('')
    })
    expect(document.body.textContent).not.toContain('gw-secret-2')
  })

  test('删除 header → 保存 → PATCH {headers:{}}（清空语义）', async () => {
    renderUi()
    await expandDefault()
    await screen.findByLabelText('X-Gw-Sign')
    fireEvent.click(screen.getByLabelText('删除 header X-Gw-Sign'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ headers: {} })
    })
  })

  test('未重输值的保留项挡住保存（write-only 构不出完整 map）', async () => {
    renderUi()
    await expandDefault()
    await screen.findByLabelText('X-Gw-Sign')
    // 新增一个 header（有值）→ 已存 X-Gw-Sign 未重输 → 保存禁用 + hint 在场。
    const draftKeyInput = screen.getByPlaceholderText('Header 名')
    fireEvent.change(draftKeyInput, { target: { value: 'X-New' } })
    fireEvent.change(screen.getByPlaceholderText('值'), { target: { value: 'v1' } })
    // 「添加」同名者有三（Section 头/HeadersEditor/模型手动添加）——按行内 scope 取。
    const draftRow = draftKeyInput.closest('div') as HTMLElement
    fireEvent.click(within(draftRow).getByRole('button', { name: '添加' }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.getByText(/重新输入值/)).toBeTruthy()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})
