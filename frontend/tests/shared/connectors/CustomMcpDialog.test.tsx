// @vitest-environment happy-dom
//
// CustomMcpDialog — 三档传输（streamable_http / sse / stdio）创建、校验、编辑回显与双语对齐。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { ConnectorSummary } from '../../../src/shared/api/types'

const { connectorApi, toastSuccess, toastError } = vi.hoisted(() => ({
  connectorApi: {
    createCustom: vi.fn(),
    updateCustom: vi.fn(),
    sync: vi.fn()
  },
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ connector: connectorApi })
}))
vi.mock('@shared/state/toast', () => ({ toastSuccess, toastError }))

import i18n from '@shared/i18n'
import enCommon from '../../../src/shared/i18n/locales/en-US/common.json'
import zhCommon from '../../../src/shared/i18n/locales/zh-CN/common.json'
import { CustomMcpDialog } from '../../../src/shared/components/connectors/CustomMcpDialog'

await i18n.changeLanguage('zh-CN')

function renderDialog(initialConnector?: ConnectorSummary | null, onSaved = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const onOpenChange = vi.fn()
  render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(CustomMcpDialog, {
        open: true,
        onOpenChange,
        initialConnector,
        onSaved
      })
    )
  )
  return { onOpenChange, onSaved }
}

function makeCustomSse(over: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    connector_id: 'legacy-sse',
    display_name: 'Legacy SSE Server',
    transport: 'sse',
    server_url: 'https://legacy.example.test/sse',
    status: 'connected',
    enabled: true,
    preprocess_enabled: false,
    scopes: null,
    last_error: null,
    last_synced_at: null,
    credential: null,
    flow: null,
    source: 'custom_mcp',
    superseded_by_catalog: false,
    is_custom: true,
    custom_header_names: ['Authorization'],
    stdio_command: null,
    stdio_env_keys: [],
    ...over
  }
}

beforeEach(() => {
  connectorApi.createCustom.mockResolvedValue(makeCustomSse())
  connectorApi.updateCustom.mockResolvedValue(makeCustomSse())
  connectorApi.sync.mockResolvedValue({
    connector_id: 'legacy-sse',
    total: 1,
    inserted: 1,
    updated: 0,
    orphaned: 0
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CustomMcpDialog — SSE 传输支持', () => {
  test('创建模式支持选择 HTTP + SSE，校验 URL 并携带 headers 落库', async () => {
    const { onSaved } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'HTTP + SSE' }))
    expect(screen.getByPlaceholderText('https://mcp.example.com/sse')).toBeTruthy()
    expect(screen.queryByPlaceholderText('npx')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('如：GitHub Enterprise / 本地文件系统'), {
      target: { value: 'Legacy SSE Server' }
    })

    // 未填 URL 时拒绝提交并提示
    fireEvent.click(screen.getByRole('button', { name: '创建连接' }))
    expect(await screen.findByText('请填写 MCP 端点 URL')).toBeTruthy()
    expect(connectorApi.createCustom).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/sse'), {
      target: { value: ' https://legacy.example.test/sse ' }
    })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    fireEvent.change(screen.getByPlaceholderText('Authorization'), {
      target: { value: 'Authorization' }
    })
    fireEvent.change(screen.getByPlaceholderText('Bearer ...'), {
      target: { value: 'Bearer tok_123' }
    })

    fireEvent.click(screen.getByRole('button', { name: '创建连接' }))

    await waitFor(() =>
      expect(connectorApi.createCustom).toHaveBeenCalledWith({
        connector_id: 'legacy-sse-server',
        display_name: 'Legacy SSE Server',
        transport: 'sse',
        server_url: 'https://legacy.example.test/sse',
        headers: { Authorization: 'Bearer tok_123' }
      })
    )
    expect(onSaved).toHaveBeenCalledWith('legacy-sse')
  })

  test('编辑模式打开 SSE 连接器时保留 sse 传输（不折叠成 streamable_http）', async () => {
    renderDialog(makeCustomSse())

    const sseButton = screen.getByRole('button', { name: 'HTTP + SSE' })
    const httpButton = screen.getByRole('button', { name: 'Streamable HTTP' })
    expect(sseButton.className).toContain('text-coral')
    expect(httpButton.className).not.toContain('text-coral')

    const urlInput = screen.getByPlaceholderText('https://mcp.example.com/sse') as HTMLInputElement
    expect(urlInput.value).toBe('https://legacy.example.test/sse')
    expect(screen.getByText('已配置加密键：Authorization')).toBeTruthy()

    fireEvent.change(urlInput, { target: { value: 'https://legacy.example.test/v2/sse' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() =>
      expect(connectorApi.updateCustom).toHaveBeenCalledWith('legacy-sse', {
        display_name: 'Legacy SSE Server',
        transport: 'sse',
        server_url: 'https://legacy.example.test/v2/sse'
      })
    )
  })

  test('在三种传输间切换 cleanly 切换表单字段', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '本机进程（stdio）' }))
    expect(screen.getByPlaceholderText('npx')).toBeTruthy()
    expect(screen.queryByPlaceholderText('https://mcp.example.com/mcp')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'HTTP + SSE' }))
    expect(screen.getByPlaceholderText('https://mcp.example.com/sse')).toBeTruthy()
    expect(screen.queryByPlaceholderText('npx')).toBeNull()
  })

  test('zh-CN 与 en-US settings.connectors.custom 键集合严格对齐', () => {
    const zhKeys = Object.keys(zhCommon.settings.connectors.custom).sort()
    const enKeys = Object.keys(enCommon.settings.connectors.custom).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys).toContain('transportSse')
    expect(zhKeys).toContain('badgeSse')
  })
})
