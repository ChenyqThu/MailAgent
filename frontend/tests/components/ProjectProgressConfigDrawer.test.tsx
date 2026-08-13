// @vitest-environment happy-dom
//
// 0804 dogfood 3d —— 项目周报（DB v31 播种的专型单例行）也有头像入口。名称仍不可编辑
// （行是单例、标题喂着列表与抽屉标题），故只并排展示，保存 patch 只带 avatar；未触碰
// 不发（PATCH 缺席 = 不动列）。mock 面镜像 PreprocessConfigDrawer.test.tsx。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const mockSave = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useProjectProgressRuns: () => ({ runs: [], isLoading: false })
}))
vi.mock('@shared/state/env', () => ({
  applyEnvPatch: vi.fn(),
  useEnvStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        state: {
          status: 'ready',
          snapshot: { values: { PROJECT_PROGRESS_SYNC_ENABLED: 'true' } }
        }
      }),
    { getState: () => ({ state: { status: 'ready', snapshot: { values: {} } } }) }
  )
}))
vi.mock('@shared/state/restart', () => ({
  useRestartStore: () => vi.fn()
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

import i18n from '@shared/i18n'
import type { ReportAgentConfig } from '@shared/api/types'
import { ProjectProgressConfigDrawer } from '../../src/shared/components/agents/drawers/ProjectProgressConfigDrawer'

await i18n.changeLanguage('zh-CN')

function makeCfg(): ReportAgentConfig {
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
    tools_json: [],
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    trigger: { v: 1, kind: 'email_filter', subject_pattern: 'weekly' },
    updated_at: null
  } as ReportAgentConfig
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectProgressConfigDrawer 头像身份（0804 dogfood 3d）', () => {
  test('默认折叠；展开选形状后保存 → patch 携带 avatar', async () => {
    render(<ProjectProgressConfigDrawer cfg={makeCfg()} open onClose={() => {}} />)
    expect(screen.getByText('项目周报同步')).toBeTruthy()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('hex'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(
        'project_progress_sync',
        expect.objectContaining({ avatar: expect.objectContaining({ type: 'bot', shape: 'hex' }) })
      )
    })
  })

  test('未触碰头像 → 保存 patch 不含 avatar（dirty-gate）', async () => {
    render(<ProjectProgressConfigDrawer cfg={makeCfg()} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave.mock.calls[0][1] as Record<string, unknown>).not.toHaveProperty('avatar')
  })

  test('名称只读（单例行不可改名）', () => {
    render(<ProjectProgressConfigDrawer cfg={makeCfg()} open onClose={() => {}} />)
    expect(screen.queryAllByDisplayValue('项目周报同步')).toHaveLength(0)
    expect(screen.getByText('项目周报同步')).toBeTruthy()
  })
})
