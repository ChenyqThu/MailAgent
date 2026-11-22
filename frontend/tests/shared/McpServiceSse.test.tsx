// @vitest-environment happy-dom
//
// MCP 服务设置页：双向传输端点展示（/mcp + /mcp/sse）、SSE 客户端配置复制/写入与 i18n 对齐。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type {
  McpKeyWithPlaintext,
  McpScopeOptions,
  McpServiceStatus,
  McpWriteClientConfigResult
} from '../../src/shared/api/types'

const { mcpApi } = vi.hoisted(() => ({
  mcpApi: {
    status: vi.fn(),
    getScopeOptions: vi.fn(),
    listKeys: vi.fn(),
    createKey: vi.fn(),
    updateKeyScopes: vi.fn(),
    rotateKey: vi.fn(),
    revokeKey: vi.fn(),
    tools: vi.fn(),
    audit: vi.fn(),
    probe: vi.fn(),
    writeClientConfig: vi.fn()
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ mcpService: mcpApi })
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

import i18n from '@shared/i18n'
import enCommon from '../../src/shared/i18n/locales/en-US'
import zhCommon from '../../src/shared/i18n/locales/zh-CN'
import { McpServiceTab } from '../../src/shared/components/settings/tabs/McpServiceTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

const LOCAL_URL = 'http://127.0.0.1:8231/mcp'
const SSE_URL = 'http://127.0.0.1:8231/mcp/sse'
const PLAINTEXT = 'mak_TESTSECRET_sse_0123456789'

const SCOPE_OPTIONS: McpScopeOptions = {
  bases: [{ id: 'readonly', scopes: ['email:read'] }],
  extras: [{ scope: 'email:draft', risk: 'low' }]
}

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <McpServiceTab />
    </QueryClientProvider>
  )
}

const clipboardWrite = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  clipboardWrite.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite }
  })
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: { path: '/tmp/.env', exists: true, values: {}, managedKeys: [], secretKeys: [] }
    }
  })
  const st: McpServiceStatus = {
    local_url: LOCAL_URL,
    streamable_http_url: LOCAL_URL,
    sse_url: SSE_URL,
    public_url: null,
    active_key_count: 1
  }
  mcpApi.status.mockResolvedValue(st)
  mcpApi.getScopeOptions.mockResolvedValue(SCOPE_OPTIONS)
  mcpApi.listKeys.mockResolvedValue([])
  mcpApi.tools.mockResolvedValue([])
  mcpApi.audit.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('McpServiceTab — Streamable HTTP 与 HTTP+SSE 端点展示及客户端配置', () => {
  test('同时展示 /mcp 与 /mcp/sse 端点，并支持一键复制 SSE 地址', async () => {
    renderTab()

    expect(await screen.findByText(LOCAL_URL)).toBeTruthy()
    expect(await screen.findByText(SSE_URL)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '复制本机 SSE 地址' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(SSE_URL))
  })

  test('旧版 status 缺少 sse_url 时自动从 local_url 派生 /mcp/sse', async () => {
    mcpApi.status.mockResolvedValue({
      local_url: LOCAL_URL,
      public_url: null,
      active_key_count: 1
    })
    renderTab()

    expect(await screen.findByText(LOCAL_URL)).toBeTruthy()
    expect(await screen.findByText(SSE_URL)).toBeTruthy()
  })

  test('密钥生成弹窗提供「复制 SSE 客户端配置」，写入 type=sse 与 sse_url', async () => {
    const created: McpKeyWithPlaintext = {
      key: {
        id: 'k_sse',
        label: 'Legacy SSE Client',
        key_prefix: 'mak_TEST',
        scopes: ['email:read'],
        preset: 'readonly',
        base: 'readonly',
        extra: [],
        custom: false,
        created_at: 1_700_000_000,
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        active: true
      },
      plaintext: PLAINTEXT
    }
    mcpApi.createKey.mockResolvedValue(created)
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '新建密钥' }))
    const createDialog = await screen.findByRole('dialog')
    await within(createDialog).findByRole('radio', { name: '只读' })
    fireEvent.change(within(createDialog).getByLabelText('名称'), {
      target: { value: 'Legacy SSE Client' }
    })
    fireEvent.click(within(createDialog).getByRole('button', { name: '新建' }))

    await screen.findByText('密钥已生成')
    const revealedDialog = screen.getByRole('dialog')
    fireEvent.click(within(revealedDialog).getByRole('button', { name: '复制 SSE 客户端配置' }))

    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(JSON.parse(clipboardWrite.mock.calls[0][0])).toEqual({
      mcpServers: {
        mailagent: {
          type: 'sse',
          url: SSE_URL,
          headers: { Authorization: `Bearer ${PLAINTEXT}` }
        }
      }
    })
  })

  test('一键配置客户端支持选择 HTTP+SSE (/mcp/sse) 并预览 SSE 配置', async () => {
    const previewRes: McpWriteClientConfigResult = {
      target: 'claude_code',
      mode: 'sse',
      server_name: 'mailagent',
      path: '/Users/test/.claude.json',
      exists: true,
      dry_run: true,
      wrote: false,
      backup_path: null,
      snippet: {
        type: 'sse',
        url: SSE_URL,
        headers: { Authorization: 'Bearer <YOUR_MAILAGENT_API_KEY>' }
      },
      preview: '{\n  "mcpServers": {}\n}'
    }
    mcpApi.writeClientConfig.mockResolvedValue(previewRes)
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '一键配置客户端' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'HTTP+SSE (/mcp/sse)' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '预览合并结果' }))

    await waitFor(() =>
      expect(mcpApi.writeClientConfig).toHaveBeenCalledWith({
        target: 'claude_code',
        mode: 'sse',
        dry_run: true
      })
    )
    expect(await within(dialog).findByText('/Users/test/.claude.json')).toBeTruthy()
  })

  test('zh-CN 与 en-US settings.mcp 子树键集合严格对齐', () => {
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k
        return v && typeof v === 'object' && !Array.isArray(v)
          ? flatten(v as Record<string, unknown>, path)
          : [path]
      })

    expect(flatten(zhCommon.settings.mcp).sort()).toEqual(flatten(enCommon.settings.mcp).sort())
  })
})
