// @vitest-environment happy-dom
//
// AiTab — provider registry 门控（task 07-12 P3）。
//
// 覆盖：
//   1. flag off（/chat/config.providerRegistryEnabled=false，默认）→ 旧「LLM 网关」区在场
//      （网关 base URL / LLM API Key / 启用模型列表），「模型服务」区不渲染 —— 字节级现状。
//   2. flag on → 「模型服务」区渲染；LLM_API_BASE / LLM_API_KEY / 启用模型勾选区消失；
//      全局默认模型 / Fallback 链下拉保留（选项源升级在 EnvField optionGroups 内部）。
//
// CustomAiSection 各自带独立取数与门控（非本 task 面）→ mock 成 null。（task 07-21：
// NotionAgentSection 已从 AiTab 摘除并删除，配置归位到 设置 → Custom AI → Skills，故不再 mock。）

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const { getAutoCompact, setAutoCompact } = vi.hoisted(() => ({
  getAutoCompact: vi.fn().mockResolvedValue('on'),
  setAutoCompact: vi.fn().mockImplementation(async (mode: 'on' | 'off') => mode)
}))

vi.mock('../../src/shared/components/settings/CustomAiSection', () => ({
  CustomAiSection: () => null,
  StandingDocsSection: () => null
}))
vi.mock('@shared/hooks/useMailApi', () => {
  const api = {
    prompts: { list: vi.fn().mockResolvedValue({ inbox: null, sent: null }) },
    settings: { testLlm: vi.fn().mockResolvedValue({ ok: true }) },
    llm: {
      listUpstreamModels: vi.fn().mockResolvedValue({ models: [], cached: false, cached_at: null })
    },
    chat: { getAutoCompact, setAutoCompact }
  }
  return { useMailApi: () => api }
})

import i18n from '@shared/i18n'
import { AiTab } from '../../src/shared/components/settings/tabs/AiTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

let registryEnabled = false
let chatCompactEnabled = false
let chatAutoCompactEnabled = false
const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  let data: unknown = {}
  if (url.includes('/chat/config')) {
    data = {
      providerRegistryEnabled: registryEnabled,
      enabledModels: [],
      chatCompactEnabled,
      chatAutoCompactEnabled
    }
  } else if (url.includes('/llm/providers')) {
    data = { providers: [], version: 1 }
  }
  return {
    ok: true,
    status: 200,
    // request() 消费 text()；/chat/config 的 flag 探针消费 json() —— 两面都给。
    text: async () => JSON.stringify({ status: 'success', data }),
    json: async () => ({ status: 'success', data })
  } as unknown as Response
})
vi.stubGlobal('fetch', mockFetch)

function setReadyEnv(): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: {},
        managedKeys: [],
        secretKeys: []
      }
    }
  })
}

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(QueryClientProvider, { client: qc }, createElement(AiTab)))
}

function autoCompactSwitch(): HTMLElement {
  const title = screen.getByText('自动压缩上下文')
  const section = title.parentElement?.parentElement
  if (!section) throw new Error('automatic Compact section not found')
  return within(section).getByRole('switch')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  getAutoCompact.mockResolvedValue('on')
  setAutoCompact.mockImplementation(async (mode: 'on' | 'off') => mode)
  chatCompactEnabled = false
  chatAutoCompactEnabled = false
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('AiTab — providerRegistryEnabled=false（默认，字节级现状）', () => {
  test('旧 LLM 网关区在场，「模型服务」不渲染', async () => {
    registryEnabled = false
    setReadyEnv()
    renderUi()
    expect(await screen.findByText('网关 base URL')).toBeTruthy()
    expect(screen.getByText('LLM API Key')).toBeTruthy()
    expect(screen.getAllByText('启用模型列表').length).toBeGreaterThan(0)
    expect(screen.getByText('全局默认模型')).toBeTruthy()
    expect(screen.queryByText('模型服务')).toBeNull()
  })
})

describe('AiTab — providerRegistryEnabled=true（模型服务取代旧网关区）', () => {
  test('「模型服务」渲染；base/key/启用模型勾选消失；模型/fallback 下拉保留', async () => {
    registryEnabled = true
    setReadyEnv()
    renderUi()
    expect(await screen.findByText('模型服务')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByText('网关 base URL')).toBeNull()
    })
    expect(screen.queryByText('LLM API Key')).toBeNull()
    expect(screen.queryByText('启用模型列表')).toBeNull()
    // 功能位下拉保留（选项源在 EnvField optionGroups 内部升级）
    expect(screen.getByText('全局默认模型')).toBeTruthy()
    expect(screen.getByText('Fallback 链')).toBeTruthy()
    expect(screen.getByText('翻译模型')).toBeTruthy()
  })
})

describe('AiTab — automatic Compact owner setting', () => {
  test('P3 与 P4 两个 flag 都开时渲染，并读取 owner 缺省 on', async () => {
    chatCompactEnabled = true
    chatAutoCompactEnabled = true
    setReadyEnv()
    renderUi()

    expect(await screen.findByText('自动压缩上下文')).toBeTruthy()
    await waitFor(() => expect(getAutoCompact).toHaveBeenCalled())
    expect(autoCompactSwitch().getAttribute('data-state')).toBe('checked')
  })

  test('任一 flag 关闭都不渲染设置面', async () => {
    chatCompactEnabled = true
    chatAutoCompactEnabled = false
    setReadyEnv()
    const first = renderUi()
    await screen.findByText('会话自动标题')
    expect(screen.queryByText('自动压缩上下文')).toBeNull()
    first.unmount()

    chatCompactEnabled = false
    chatAutoCompactEnabled = true
    renderUi()
    await screen.findByText('会话自动标题')
    expect(screen.queryByText('自动压缩上下文')).toBeNull()
    expect(getAutoCompact).not.toHaveBeenCalled()
  })

  test('Switch 写入 off，并收敛到服务端返回值', async () => {
    chatCompactEnabled = true
    chatAutoCompactEnabled = true
    setReadyEnv()
    renderUi()

    await screen.findByText('自动压缩上下文')
    const toggle = autoCompactSwitch()
    toggle.click()
    await waitFor(() => expect(setAutoCompact).toHaveBeenCalledWith('off'))
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('unchecked'))
  })
})
