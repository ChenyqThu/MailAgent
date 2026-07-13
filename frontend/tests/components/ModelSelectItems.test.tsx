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

await i18n.changeLanguage('zh-CN')

let registryEnabled = false
const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  const data = url.includes('/chat/config') ? { providerRegistryEnabled: registryEnabled } : {}
  return {
    ok: true,
    status: 200,
    // request() 消费 text()；fetchProviderRegistryEnabled 消费 json() —— 两面都给。
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
