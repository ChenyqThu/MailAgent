// @vitest-environment happy-dom
//
// Lane 2 #2 — KOS「仅推已标注」×「AI 分类关」静默死锁的联动警告（issue #49 / prd Lane 2）。
//
// KOS_REQUIRE_LABELED=true + LLM_AGENT_ENABLED=false 是静默死锁组合：入库开着、凭据齐、
// 看板显示 active，但一封都推不进去、零报错（producer 的 `missing` 态成因就是没跑过
// LLM）。prd 明确要求**联动式**警告而非静态 helper —— 这里按四种 env 组合断言：
//   仅 toggle=on 且分类=off 时渲染，其余组合一律不渲染。
// 另断言警告携带跳转 Agents 页的 CTA（navigate to /agents）。
//
// Pure UI test — 镜像 SystemCapabilitiesSection.test.tsx 的 mock 布线（identity i18n /
// 受控 env store / EnvField stub / captured navigate）。警告组件在 AdvancedDisclosure
// 内，折叠态子树仍挂载（CollapsibleRegion 0fr + inert），queryByText 可直接断言
// 条件渲染逻辑本身。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

// ---------------------------------------------------------------------------
// Mocks (declared before importing the component)
// ---------------------------------------------------------------------------

// i18n — identity translation so assertions use the key string
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// TanStack Router — capture navigate() calls (跳转 Agents 页 CTA)
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

// env store — 受控 snapshot；per-test 改 envValues 摆出四种组合。
const { envValues } = vi.hoisted(() => ({ envValues: {} as Record<string, string> }))
vi.mock('@shared/state/env', () => ({
  useEnvStore: (selector: (s: unknown) => unknown) =>
    selector({ state: { status: 'ready', snapshot: { values: envValues, secretKeys: [] } } }),
  applyEnvPatch: vi.fn(async () => ({ ok: true, changedKeys: [] }))
}))
vi.mock('@shared/state/restart', () => ({
  useRestartStore: (selector: (s: unknown) => unknown) => selector({ markRestartRequired: vi.fn() })
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

// EnvField / EnvSecretField — 声明式控件 stub 掉（本测试只关心警告的条件渲染）。
vi.mock('@shared/components/settings/parts/EnvField', () => ({
  EnvField: () => null
}))
vi.mock('@shared/components/settings/parts/EnvSecretField', () => ({
  EnvSecretField: () => null
}))

// KOS gate hook（/chat/config probe）— 与警告无关，钉成未启用态。
vi.mock('@shared/hooks/useLlmModels', () => ({
  useKosGate: () => ({ consumerEnabled: false, configured: false, isLoading: false })
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { kosDoctor: vi.fn(async () => []) } })
}))

import { IntegrationsTab } from '../../src/shared/components/settings/tabs/IntegrationsTab'

const WARNING_KEY = 'settings.integrations.kos.requireLabeled.deadlockWarning'
const CTA_KEY = 'settings.integrations.kos.requireLabeled.goToAgents'

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(IntegrationsTab)))
}

function setEnv(values: Record<string, string>): void {
  for (const k of Object.keys(envValues)) delete envValues[k]
  Object.assign(envValues, values)
}

afterEach(() => {
  cleanup()
  mockNavigate.mockReset()
  setEnv({})
})

describe('KOS 仅推已标注 × AI 分类关 — 联动死锁警告', () => {
  test('toggle=on 且分类=off → 渲染警告', () => {
    setEnv({ KOS_REQUIRE_LABELED: 'true', LLM_AGENT_ENABLED: 'false' })
    renderTab()
    expect(screen.getByText(new RegExp(WARNING_KEY))).toBeTruthy()
  })

  test("toggle='1'（envFlagOn 的另一真值形态）且分类未设 → 同样渲染", () => {
    setEnv({ KOS_REQUIRE_LABELED: '1' })
    renderTab()
    expect(screen.getByText(new RegExp(WARNING_KEY))).toBeTruthy()
  })

  test('toggle=on 且分类=on → 不渲染', () => {
    setEnv({ KOS_REQUIRE_LABELED: 'true', LLM_AGENT_ENABLED: 'true' })
    renderTab()
    expect(screen.queryByText(new RegExp(WARNING_KEY))).toBeNull()
  })

  test('toggle=off（显式 false）→ 不渲染（无论分类开关）', () => {
    setEnv({ KOS_REQUIRE_LABELED: 'false', LLM_AGENT_ENABLED: 'false' })
    renderTab()
    expect(screen.queryByText(new RegExp(WARNING_KEY))).toBeNull()
  })

  test('toggle 未设（默认 false）→ 不渲染', () => {
    setEnv({})
    renderTab()
    expect(screen.queryByText(new RegExp(WARNING_KEY))).toBeNull()
  })

  test('警告里的 CTA 点击 → navigate 到 /agents（不是静态文案）', () => {
    setEnv({ KOS_REQUIRE_LABELED: 'true' })
    renderTab()
    fireEvent.click(screen.getByText(CTA_KEY))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' })
  })
})
