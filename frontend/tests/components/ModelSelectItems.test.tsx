// @vitest-environment happy-dom
//
// ModelSelectItems — Agents 抽屉共用模型选择项（task 07-12 P3）。
//
// 覆盖：
//   1. flag off（providerRegistryEnabled=false）→ 扁平列表 + orphan 追加 +「（未启用）」
//      标注（与收编前各抽屉内联代码等价的结构）
//   2. flag on → 按 provider 分组：default 组标签「default（主网关）」、其余组标签 =
//      providerId；组内显示去前缀 model id、value 保持完整 providerRef
//
// radix Select 需要 Root 上下文才能渲染 Item —— 这里 mock ui/select 为透明 div（测的是
// 本组件的分组/标注逻辑，不测 radix 行为）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

vi.mock('@shared/components/ui/select', () => ({
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <div data-testid="item" data-value={value}>
      {children}
    </div>
  ),
  SelectGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="group">{children}</div>
  ),
  SelectLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="group-label">{children}</div>
  )
}))

import i18n from '@shared/i18n'
import { ModelSelectItems } from '../../src/shared/components/agents/drawers/ModelSelectItems'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useProviderRegistryEnabled } from '@shared/hooks/useLlmProviders'

await i18n.changeLanguage('zh-CN')

let registryEnabled = false
const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  const data = url.includes('/chat/config') ? { providerRegistryEnabled: registryEnabled } : {}
  return {
    ok: true,
    status: 200,
    // request() 消费 text()；/chat/config 模型面探针消费 json() —— 两面都给。
    text: async () => JSON.stringify({ status: 'success', data }),
    json: async () => ({ status: 'success', data })
  } as unknown as Response
})
vi.stubGlobal('fetch', mockFetch)

function renderItems(models: string[], current: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ModelSelectItems, { models, current })
    )
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ModelSelectItems — flag off（默认）', () => {
  test('扁平列表，无分组；orphan 追加并标注（未启用）', async () => {
    registryEnabled = false
    renderItems(['claude-sonnet-4-6', 'gpt-5.5'], 'old-model')
    const items = await screen.findAllByTestId('item')
    expect(items.map((el) => el.getAttribute('data-value'))).toEqual([
      'claude-sonnet-4-6',
      'gpt-5.5',
      'old-model'
    ])
    expect(screen.queryAllByTestId('group')).toHaveLength(0)
    expect(items[2].textContent).toContain('old-model')
    expect(items[2].textContent).toContain('（未启用）')
    expect(items[0].textContent).not.toContain('（未启用）')
  })
})

describe('ModelSelectItems — flag on（分组）', () => {
  test('default 组最前带「主网关」标签，providerRef 组内去前缀显示、value 保持全串', async () => {
    registryEnabled = true
    renderItems(['claude-sonnet-4-6', 'dash:qwen-max', 'kimi:kimi-k2'], null)
    const labels = await screen.findAllByTestId('group-label')
    expect(labels.map((el) => el.textContent)).toEqual(['default（主网关）', 'dash', 'kimi'])
    const items = screen.getAllByTestId('item')
    const byValue = new Map(items.map((el) => [el.getAttribute('data-value'), el.textContent]))
    // value = 完整 providerRef（写入面不变）；显示 = 去前缀 model id
    expect(byValue.get('dash:qwen-max')).toBe('qwen-max')
    expect(byValue.get('kimi:kimi-k2')).toBe('kimi-k2')
    expect(byValue.get('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('orphan providerRef 落自己的 provider 组并保留（未启用）标注', async () => {
    registryEnabled = true
    renderItems(['claude-sonnet-4-6'], 'dash:qwen-gone')
    const labels = await screen.findAllByTestId('group-label')
    expect(labels.map((el) => el.textContent)).toEqual(['default（主网关）', 'dash'])
    const orphan = screen
      .getAllByTestId('item')
      .find((el) => el.getAttribute('data-value') === 'dash:qwen-gone')
    expect(orphan?.textContent).toContain('qwen-gone')
    expect(orphan?.textContent).toContain('（未启用）')
  })
})

describe('/chat/config 探针共享（批 2 review LOW-7）', () => {
  test('flag 探针与 enabledModels 共用同一 query —— 双 hook 同挂只发一次 /chat/config', async () => {
    registryEnabled = false
    // 模拟 AiTab / 抽屉的真实组合：模型列表 hook + flag 探针 hook 同时在场。
    function Probe(): React.ReactElement {
      const { models } = useEnabledModels()
      const enabled = useProviderRegistryEnabled()
      return (
        <div data-testid="probe" data-enabled={String(enabled)} data-models={models.length} />
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        <>
          <Probe />
          <ModelSelectItems models={['claude-sonnet-4-6']} current={null} />
        </>
      )
    )
    await screen.findByTestId('probe')
    await screen.findAllByTestId('item')
    const chatConfigCalls = mockFetch.mock.calls.filter(([input]) =>
      String(input).includes('/chat/config')
    )
    expect(chatConfigCalls).toHaveLength(1)
  })
})
