// @vitest-environment happy-dom
//
// 设置-AI「外部连接（MCP）」区 —— 08-06 起降级为指向 /connectors 配置台的深链卡。
// 钉住的契约：
//   1. flag off（connectorToolsEnabled ≠ true）→ 整区不渲染（门控语义与旧区块一致）。
//   2. flag on → 只渲染指路卡：**零 /api/connector/* 请求**（数据只有配置台一个可写面，
//      这里连读都不发 —— 两处读写同一份数据正是本次迁移要消灭的形态）。
//   3. 点「打开 Connectors」→ navigate 到 /connectors?item=external。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => ({})
}))

const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

const { connectorApi } = vi.hoisted(() => ({
  connectorApi: { list: vi.fn(), catalog: vi.fn(), tools: vi.fn() }
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ connector: connectorApi })
}))

import { ConnectorsSection } from '../../../src/shared/components/settings/custom-ai/ConnectorsSection'

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ConnectorsSection))
  )
}

beforeEach(() => {
  flagFetch.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConnectorsSection（设置页深链卡）', () => {
  test('flag off → 整区不渲染，零 /api/connector 请求', async () => {
    flagFetch.mockResolvedValue(false)
    renderUi()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByText('settings.connectors.title')).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag on → 渲染指路卡，仍然零 /api/connector 请求（这里不再是数据面）', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('settings.connectors.title')).toBeTruthy())
    expect(screen.getByText('connectorsConsole.settingsLink.movedTitle')).toBeTruthy()
    expect(connectorApi.list).not.toHaveBeenCalled()
    expect(connectorApi.catalog).not.toHaveBeenCalled()
  })

  test('点「打开 Connectors」→ 深链到 /connectors?item=external', async () => {
    renderUi()
    const open = await screen.findByRole('button', {
      name: /connectorsConsole\.settingsLink\.open/
    })
    fireEvent.click(open)
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/connectors',
      search: { item: 'external' }
    })
  })
})
