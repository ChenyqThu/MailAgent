// @vitest-environment happy-dom
//
// g3 lane U — 一键建局的两个入口（实验室快捷入口 + 建群对话框的「从模板创建」）。
//
// 钉四件事：
//   L1 labs off → 实验室里连按钮都不渲染（狼人杀是这套编排的集成验收，开关关着时它一条都不生效）；
//   L2 labs on → 点一下调 createWerewolfGame 一次，成功后 toast 带局名 + 落到主群
//      （segment='groups' + activeGroupSessionId=主群 id + navigate('/sessions')）；
//   L3 configApplied:false → 只提示不跳（群在，但没有法官位，跳过去看到的是个说不清的群）；
//   L4 端点失败 → toastError，不跳；
//   L5 NewGroupDialog 的「从模板创建」：labs off 禁用；labs on 点击 → 主群交给 onCreated 并关窗。
//
// 🔴 应答里的 roles / players 是身份事实：用例特意在应答里塞了它们，并断言 toast / DOM 里
//    一个角色词都不出现（安全红线，不是文案偏好）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    services: { restart: vi.fn().mockResolvedValue({ ok: true }) },
    chat: { newSession: vi.fn(), deleteSession: vi.fn() }
  })
}))

vi.mock('@shared/components/agents/hooks', () => ({
  useOpennessFlags: () => ({ connectorToolsEnabled: false })
}))

const mockGetLabs = vi.fn()
const mockCreateWerewolfGame = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: (...args: unknown[]) => mockGetLabs(...args),
  setLabs: vi.fn(),
  getGroupConfig: vi.fn(),
  setGroupConfig: vi.fn(),
  getGroupMetrics: vi.fn(),
  createWerewolfGame: (...args: unknown[]) => mockCreateWerewolfGame(...args)
}))

const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
vi.mock('@shared/state/toast', () => ({
  toastSuccess: (...args: unknown[]) => mockToastSuccess(...args),
  toastError: (...args: unknown[]) => mockToastError(...args)
}))

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string }) => <span data-avatar={props.agentId} />
}))

import i18n from '@shared/i18n'
import type { ChatSession, ReportAgentConfig } from '@shared/api/types'
import { useSessionsSegment } from '@shared/state/sessions-segment'
import { useEnvStore } from '@shared/state/env'
import { LabsTab } from '../../src/shared/components/settings/tabs/LabsTab'
import { NewGroupDialog } from '../../src/shared/components/agents/groups/NewGroupDialog'

await i18n.changeLanguage('zh-CN')

const MAIN_SESSION = {
  id: 901,
  email_id: null,
  anchor_type: 'general',
  anchor_id: null,
  backend_kind: 'ai-sdk',
  backend_model: null,
  backend_agent_page_id: null,
  title: '狼人杀 #1',
  archived: false,
  created_at: 1,
  updated_at: 1,
  origin: 'group',
  members_json: '["judge","p1","p2","p3","p4","p5","p6"]'
} as ChatSession

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainSessionId: 901,
    wolfSessionId: 902,
    seerSessionId: 903,
    mainSession: MAIN_SESSION,
    title: '狼人杀 #1',
    seed: 7,
    judgeAgentId: 'judge',
    roles: { p1: 'wolf', p2: 'wolf', p3: 'seer', p4: 'villager', p5: 'villager', p6: 'villager' },
    players: [{ agentId: 'p1', title: '玩家甲', role: 'wolf' }],
    reusedAgents: false,
    configApplied: true,
    ...over
  }
}

function renderLabs(): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: {
          MAILAGENT_MCP_CONNECTORS: 'false',
          MAILAGENT_SKILL_CATALOG_PROMPT: 'false',
          MAILAGENT_MEMORY_LAYERS: 'false',
          MAILAGENT_AG_UI_MIRROR: 'false'
        },
        managedKeys: [],
        secretKeys: []
      }
    }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LabsTab />
    </QueryClientProvider>
  )
}

const onCreated = vi.fn()
const onOpenChange = vi.fn()

function renderDialog(labsOn: boolean): void {
  const candidates = [
    { id: 'a1', type: 'custom', title: '调研员', enabled: true } as ReportAgentConfig
  ]
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <NewGroupDialog
        open
        onOpenChange={onOpenChange}
        candidates={candidates}
        onCreated={onCreated}
        labsOn={labsOn}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
  mockCreateWerewolfGame.mockResolvedValue(payload())
  useSessionsSegment.setState({ segment: 'ai', activeGroupSessionId: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('狼人杀一键建局入口', () => {
  test('L1 labs off → 实验室里没有「一键建局」按钮', async () => {
    renderLabs()
    // 等 labs 读回来（读回之前 groupAgents 开关是禁用态），确认不是「还没加载所以没渲染」。
    await waitFor(() =>
      expect(
        (screen.getByRole('switch', { name: '群聊多 agent（实验）' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
    expect(screen.queryByRole('button', { name: '一键建局' })).toBeNull()
  })

  test('L2 labs on → 点击建局一次，成功后 toast 带局名并落到主群', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    renderLabs()
    const button = await screen.findByRole('button', { name: '一键建局' })
    fireEvent.click(button)
    await waitFor(() => expect(mockCreateWerewolfGame).toHaveBeenCalledTimes(1))
    expect(mockCreateWerewolfGame).toHaveBeenCalledWith({})
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('已建局：狼人杀 #1'))
    expect(useSessionsSegment.getState().segment).toBe('groups')
    expect(useSessionsSegment.getState().activeGroupSessionId).toBe(901)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/sessions' })
    // 🔴 角色分配永不上界面。判据是「谁是什么」这条映射的两头：应答里的六个玩家 id / 标题，
    // 与 roles 的三个值，都不许出现在 toast 参数或 DOM 里。
    // （不能笼统地 grep「狼人」——helper 文案本来就要说明「建了一个狼人子群」，那是群结构不是身份。）
    const shown = JSON.stringify(mockToastSuccess.mock.calls) + document.body.textContent
    for (const token of ['p1', 'p2', 'p3', '玩家甲', 'wolf', 'seer', 'villager']) {
      expect(shown.includes(token), `界面泄漏了身份事实 ${token}`).toBe(false)
    }
  })

  test('L3 configApplied:false → 只提示不跳转', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockCreateWerewolfGame.mockResolvedValue(payload({ configApplied: false }))
    renderLabs()
    fireEvent.click(await screen.findByRole('button', { name: '一键建局' }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        '已建群，但群设置未写全：请在群详情面重新确认法官位'
      )
    )
    expect(mockToastSuccess).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(useSessionsSegment.getState().activeGroupSessionId).toBeNull()
  })

  test('L4 端点失败 → toastError，不跳转', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockCreateWerewolfGame.mockRejectedValue(new Error('boom'))
    renderLabs()
    fireEvent.click(await screen.findByRole('button', { name: '一键建局' }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('建局失败', 'boom'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('L5 建群对话框的「从模板创建」：labs off 禁用；on 时点击 → 主群交给 onCreated 并关窗', async () => {
    renderDialog(false)
    expect((screen.getByRole('button', { name: '从模板创建' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(mockCreateWerewolfGame).not.toHaveBeenCalled()
    cleanup()

    renderDialog(true)
    const button = screen.getByRole('button', { name: '从模板创建' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(mockCreateWerewolfGame).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(MAIN_SESSION))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
