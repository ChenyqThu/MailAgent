// @vitest-environment happy-dom
//
// P4a agent-config lane — 「项目周报同步」配置页。承接两个旧文件退役的断言：
//   • ProjectProgressConfigDrawer.test —— 双源写（row: enabled + email_filter trigger；
//     env: 总闸 / 项目库 ID / BU 过滤，dirty 追踪 + 重启横幅）、空触发前端先拒；
//   • ProjectProgressAgentTab.test —— 总闸 on/off 的面上口径 + `agents.projectProgress`
//     的 zh/en key 对齐（那条不依赖任何渲染，原样搬进来）。
// 本页新增的两处交互（r7 §三 判据 4 / 5）也在这里钉：标题正则实时校验 + 「拿最近 5 封
// 标题试一下」、项目库 ID 粘链接可提取。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const { mockSave, mockApplyEnvPatch, STABLE_API, mockEmailList } = vi.hoisted(() => {
  const list = vi.fn()
  return {
    mockSave: vi.fn(),
    mockApplyEnvPatch: vi.fn(),
    mockEmailList: list,
    // 稳定单例（同真 useMailApi 的工厂语义）——避免消费方每渲染拿到新引用。
    STABLE_API: { email: { list } }
  }
})

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false })
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => STABLE_API }))

vi.mock('@shared/state/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/state/env')>()),
  applyEnvPatch: mockApplyEnvPatch
}))

vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

import i18n from '@shared/i18n'
import { ProjectProgressSettings } from '../../src/shared/components/agents/settings/ProjectProgressSettings'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import type { ReportAgentConfig } from '@shared/api/types'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function setEnv(values: Record<string, string>): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: { path: '/tmp/.env', exists: true, values, managedKeys: [], secretKeys: [] }
    }
  })
}

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'project_progress_sync',
    type: 'project_progress',
    enabled: true,
    title: '项目周报同步',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: '',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    trigger: { v: 1, kind: 'email_filter', subject_pattern: '\\[weekly\\]', sender_pattern: '' },
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

function renderSettings(over: Partial<ReportAgentConfig> = {}) {
  return render(createElement(ProjectProgressSettings, { cfg: makeCfg(over) }), {
    wrapper: makeQcWrapper()
  })
}

const subjectInput = (): HTMLElement => screen.getByPlaceholderText('例如：\\[weekly\\] 项目进度')
const senderInput = (): HTMLElement => screen.getByPlaceholderText('例如：weekly@corp.com')
const dbIdInput = (): HTMLElement => screen.getByPlaceholderText('（未配置 —— 同步会失败）')

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}

beforeEach(() => {
  mockSave.mockResolvedValue({})
  mockApplyEnvPatch.mockResolvedValue({
    ok: true,
    path: '/tmp/.env',
    changedKeys: ['PROJECT_PROGRESS_SYNC_ENABLED'],
    restartRequired: true
  })
  mockEmailList.mockResolvedValue([])
  setEnv({ PROJECT_PROGRESS_SYNC_ENABLED: 'false' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
  useRestartStore.setState({ required: false, changedKeys: [] })
})

// 从 ProjectProgressAgentTab.test.tsx 原样迁入（不依赖渲染，随旧文件删除会白丢）。
describe('i18n — agents.projectProgress key 对齐', () => {
  test('zh / en 顶层 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.projectProgress).sort()
    const enKeys = Object.keys(enCommon.agents.projectProgress).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})

describe('总闸口径', () => {
  test('总闸未开 → 页头横幅说清「同步不会运行」', () => {
    renderSettings()
    expect(screen.getByText(/总开关未开：同步不会运行。/)).toBeTruthy()
  })

  test('总闸已开 → 横幅换成「保存即生效」', () => {
    setEnv({ PROJECT_PROGRESS_SYNC_ENABLED: 'true' })
    renderSettings()
    expect(screen.getByText(/总开关已开/)).toBeTruthy()
  })
})

describe('双源写 — env 总闸 / 库 ID / BU 过滤 + 行 enabled', () => {
  test('打开同步总开关 → 写 env + 挂重启横幅，行 PATCH 仍带 enabled', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: '同步总开关' }))
    save()
    await waitFor(() => expect(mockApplyEnvPatch).toHaveBeenCalledTimes(1))
    expect(mockApplyEnvPatch).toHaveBeenCalledWith({ PROJECT_PROGRESS_SYNC_ENABLED: 'true' })
    expect(useRestartStore.getState().changedKeys).toContain('PROJECT_PROGRESS_SYNC_ENABLED')
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][0]).toBe('project_progress_sync')
    expect(mockSave.mock.calls[0][1]).toEqual({ enabled: true })
  })

  test('什么都没碰 → 不写 env，行 PATCH 只有 enabled（不覆写 trigger / 头像）', async () => {
    renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockApplyEnvPatch).not.toHaveBeenCalled()
    const patch = mockSave.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(patch)).toEqual(['enabled'])
  })

  // 承接 ProjectProgressConfigDrawer.test 的头像三条（上面那条只钉住 dirty-gate 的否定面，
  // 光有否定面时把 `if (avatarDirty) patch.avatar = avatar` 删掉两条都还是绿的）。
  test('头像编辑器默认折叠；展开选形状 → 行 PATCH 携带 avatar；名称仍不可编辑', async () => {
    renderSettings()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('cloudee'))
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    const patch = mockSave.mock.calls[0][1] as Record<string, unknown>
    expect(patch.avatar).toMatchObject({ type: 'bot', shape: 'cloudee' })
    // 单例行不可改名 → 身份区只读展示标题，没有名称输入框。
    expect(screen.queryByDisplayValue('项目周报同步')).toBeNull()
  })

  test('改触发规则 → 行 PATCH 带 email_filter trigger（空的那半不发键）', async () => {
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: '^\\[周报\\]' } })
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect((mockSave.mock.calls[0][1] as Record<string, unknown>).trigger).toEqual({
      v: 1,
      kind: 'email_filter',
      subject_pattern: '^\\[周报\\]'
    })
  })
})

describe('触发规则的前端闸', () => {
  test('标题与发件人同时清空 → 就地拒绝，不发请求', async () => {
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: '' } })
    fireEvent.change(senderInput(), { target: { value: '' } })
    save()
    expect(
      await screen.findByText('标题正则与发件人不能同时为空（要停用请用上方启用开关）')
    ).toBeTruthy()
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('正则编译不过 → 当场标红 + 试跑按钮禁用 + 保存被拒', async () => {
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: '[weekly' } })
    expect(screen.getByTestId('subject-regex-feedback').textContent).toContain('正则无法编译')
    expect(
      (screen.getByRole('button', { name: '拿最近 5 封标题试一下' }) as HTMLButtonElement).disabled
    ).toBe(true)
    save()
    // 字段处的实时反馈 + 保存被拒的错误条，两处都在说同一件事。
    await waitFor(() => expect(screen.getAllByText(/正则无法编译/)).toHaveLength(2))
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('正则可用 → 绿字反馈', () => {
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: '^\\[weekly\\]' } })
    expect(screen.getByTestId('subject-regex-feedback').textContent).toBe('正则可用')
  })
})

describe('「拿最近 5 封标题试一下」', () => {
  test('取收件箱最近 5 封，逐条标命中 / 未命中（re.search 语义，不加锚点）', async () => {
    mockEmailList.mockResolvedValue([
      { subject: '[weekly] 项目进度 W35' },
      { subject: '本周例会纪要' },
      { subject: 'FW: [weekly] 项目进度 W34' }
    ])
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: '\\[weekly\\]' } })
    fireEvent.click(screen.getByRole('button', { name: '拿最近 5 封标题试一下' }))
    const trial = await screen.findByTestId('subject-regex-trial')
    expect(mockEmailList).toHaveBeenCalledWith({ mailbox: '收件箱', limit: 5 })
    const rows = Array.from(trial.children).map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('命中')
    expect(rows[1]).toContain('未命中')
    // 子串命中：前面有 "FW: " 也算（Python re.search 同义），加了 ^ 锚点就会红。
    expect(rows[2]).toContain('命中')
    expect(within(trial).queryAllByText('未命中')).toHaveLength(1)
  })

  test('一封都没取到 → 说清是没取到，不假装全未命中', async () => {
    mockEmailList.mockResolvedValue([])
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: '拿最近 5 封标题试一下' }))
    expect(await screen.findByText('没取到收件箱标题')).toBeTruthy()
  })

  test('取标题失败 → 出错文案，不静默', async () => {
    mockEmailList.mockRejectedValue(new Error('ipc down'))
    renderSettings()
    fireEvent.change(subjectInput(), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: '拿最近 5 封标题试一下' }))
    expect(await screen.findByText('取标题失败，稍后再试')).toBeTruthy()
  })
})

describe('项目进度库 ID 的格式识别', () => {
  test('32 位十六进制（带连字符）→ 「格式正确」', () => {
    renderSettings()
    fireEvent.change(dbIdInput(), {
      target: { value: '31a15375-830d-8179-8e75-fcfce933808b' }
    })
    expect(screen.getByText('格式正确')).toBeTruthy()
  })

  test('粘 Notion 链接 → 提取库 ID，点「使用这个 ID」回填并写进 env', async () => {
    renderSettings()
    fireEvent.change(dbIdInput(), {
      target: {
        value: 'https://www.notion.so/tp-link/AW-Catch-Up-31a15375830d81798e75fcfce933808b?v=abc'
      }
    })
    expect(screen.getByText('已识别库 ID：31a15375830d81798e75fcfce933808b')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '使用这个 ID' }))
    expect((dbIdInput() as HTMLInputElement).value).toBe('31a15375830d81798e75fcfce933808b')
    save()
    await waitFor(() => expect(mockApplyEnvPatch).toHaveBeenCalledTimes(1))
    expect(mockApplyEnvPatch).toHaveBeenCalledWith({
      PROJECT_PROGRESS_DATABASE_ID: '31a15375830d81798e75fcfce933808b'
    })
  })

  test('乱填 → 提示不像库 ID（不拦保存，只反馈）', () => {
    renderSettings()
    fireEvent.change(dbIdInput(), { target: { value: '项目进度库' } })
    expect(screen.getByText(/不像 Notion 库 ID/)).toBeTruthy()
  })
})
