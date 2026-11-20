// @vitest-environment happy-dom
//
// ModelServicesSection — Settings「模型服务」区（task 07-12 P3 + Magpie Workbench 升级）unit tests.
//
// 覆盖：
//   1. Master-Detail 列表 + 详情切换（CRS default 无删除钮；切到 Qwen 有删除钮）
//   2. AddProviderDialog 添加流：模板预填 → POST body（protocol/baseUrl 来自模板，空 key 不携带 apiKey）
//   3. secret 掩码：apiKey 输入 placeholder 只见 hasKey+last4，新值 blur → PATCH 后清空，明文不残留 DOM
//   4. 连通性测试：ok → 「连接正常（{ms}ms）」；error → 可读文案
//   5. 模型管理：启用勾选 → PUT {id, enabled:false}；拉取 → POST /models/refresh（零 GET ?refresh=）
//   6. 增量式 Header 编辑（headerPatch）：只显名 + 占位；更新单键 → PATCH {headerPatch:{k:v}}；
//      删除单键 → PATCH {headerPatch:{k:null}}；新增单键无需重输其余保留 Header

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import i18n from '@shared/i18n'
import { ModelServicesSection } from '../../src/shared/components/settings/providers/ModelServicesSection'

await i18n.changeLanguage('zh-CN')

type Call = { method: string; url: string; body: unknown }
const calls: Call[] = []

const DEFAULT_PROVIDER = {
  id: 'default',
  protocol: 'anthropic',
  displayName: 'CRS',
  baseUrl: 'https://crs.example.com/api',
  headerNames: ['X-Gw-Sign'],
  enabled: true,
  sortOrder: 0,
  hasKey: true,
  keyLast4: '1234',
  keyCount: 1,
  extraKeyLast4s: [],
  customIcon: null,
  enabledModelCount: 1,
  totalModelCount: 1,
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
  headerNames: [],
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
        contextWindow: null,
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
          contextWindow: null,
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

describe('ModelServicesSection — 列表与配置弹窗切换', () => {
  test('渲染纵向列表（含启停开关）；点击行开弹窗：default 无删除钮，点击 Qwen 显示删除钮', async () => {
    renderUi()
    expect(await screen.findByText('CRS')).toBeTruthy()
    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.getByText('anthropic')).toBeTruthy()
    expect(screen.getByText('默认')).toBeTruthy()

    // 行内启停开关可直接切换
    fireEvent.click(screen.getByLabelText('启用/停用 Qwen'))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/dash'))
      expect(patch?.body).toEqual({ enabled: false })
    })

    // 点击 CRS 打开配置弹窗（default 无删除钮）
    fireEvent.click(screen.getByLabelText('配置 CRS'))
    const crsDialog = await screen.findByRole('dialog')
    expect(within(crsDialog).queryByLabelText('删除 CRS')).toBeNull()

    // 关闭后点击 Qwen（非 default 有删除钮）
    fireEvent.click(within(crsDialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByLabelText('配置 Qwen'))
    const qwenDialog = await screen.findByRole('dialog')
    expect(await within(qwenDialog).findByLabelText('删除 Qwen')).toBeTruthy()
  })
})

describe('ModelServicesSection — AddProviderDialog 添加流', () => {
  test('模板预填 protocol/baseUrl，创建 → POST /llm/providers body 对齐模板', async () => {
    renderUi()
    await screen.findByText('CRS')
    fireEvent.click(screen.getAllByText('添加')[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('创建'))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/llm/providers')
      )
      expect(post).toBeTruthy()
      expect(post!.body).toMatchObject({
        id: 'anthropic',
        protocol: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: ''
      })
      expect('apiKey' in (post!.body as Record<string, unknown>)).toBe(false)
    })
  })
})

describe('ModelServicesSection — secret 掩码', () => {
  test('placeholder 只见掩码（····1234），新值 blur → PATCH 且输入清空、明文不残留', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与安全' }))
    const input = (await within(dialog).findByPlaceholderText(/····1234/)) as HTMLInputElement
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
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /测试连接/ }))
    expect(await within(dialog).findByText('连接正常（123ms）')).toBeTruthy()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/test'))).toBe(true)
  })

  test('错误 key → 展示后端可读报错', async () => {
    testResult = {
      ok: false,
      latencyMs: 45,
      error: 'authentication failed (HTTP 401) — check the API key'
    }
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /测试连接/ }))
    expect(await within(dialog).findByText(/authentication failed \(HTTP 401\)/)).toBeTruthy()
  })
})

describe('ModelServicesSection — 模型管理', () => {
  test('已配 Key 默认打开模型 Tab：启用勾选 → PUT {id, enabled:false}', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    const checkbox = await within(dialog).findByLabelText('claude-sonnet-4-6')
    fireEvent.click(checkbox)
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      expect(put!.body).toEqual({ id: 'claude-sonnet-4-6', enabled: false })
    })
  })

  test('拉取模型列表 → POST /models/refresh（独立写端点，GET 纯读）', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByText('拉取模型列表'))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/models/refresh'))).toBe(true)
    })
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('refresh='))).toBe(false)
  })
})

describe('ModelServicesSection — 增量 headers write-only（headerPatch）', () => {
  test('已存 header 只显名不回显值；单键更新 → PATCH headerPatch，明文不残留 DOM', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与安全' }))
    const input = (await within(dialog).findByLabelText('X-Gw-Sign')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: 'gw-secret-2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '更新' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ headerPatch: { 'X-Gw-Sign': 'gw-secret-2' } })
    })
    await waitFor(() => {
      expect((within(dialog).getByLabelText('X-Gw-Sign') as HTMLInputElement).value).toBe('')
    })
    expect(document.body.textContent).not.toContain('gw-secret-2')
  })

  test('单键删除 header → PATCH {headerPatch:{[name]:null}}', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与安全' }))
    await within(dialog).findByLabelText('X-Gw-Sign')
    fireEvent.click(within(dialog).getByLabelText('删除 header X-Gw-Sign'))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ headerPatch: { 'X-Gw-Sign': null } })
    })
  })

  test('新增 header → PATCH {headerPatch:{X-New:v1}}，无需重填已有加密 header', async () => {
    renderUi()
    fireEvent.click(await screen.findByLabelText('配置 CRS'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与安全' }))
    await within(dialog).findByLabelText('X-Gw-Sign')
    const draftKeyInput = within(dialog).getByPlaceholderText('Header 名')
    fireEvent.change(draftKeyInput, { target: { value: 'X-New' } })
    fireEvent.change(within(dialog).getByPlaceholderText('值'), { target: { value: 'v1' } })
    const draftRow = draftKeyInput.closest('div') as HTMLElement
    fireEvent.click(within(draftRow).getByRole('button', { name: '添加' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch!.body).toEqual({ headerPatch: { 'X-New': 'v1' } })
    })
  })
})
