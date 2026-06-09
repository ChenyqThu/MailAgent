// @vitest-environment happy-dom
//
// 多文件夹同步 (P3) — FolderPicker 组件测。
//
// 覆盖: 拉取(discover→树渲染) / 勾选(toggle imap_name) / 保存(setWhitelist 调用 +
// restart 标记) / 门控(env MAILAGENT_BACKEND≠davmail → veil + 不发 discover) /
// 空态(tree 为空 → 引导文案)。
//
// useMailApi.folder.discover/setWhitelist 用 vi.fn mock; useEnvStore 注入 ready
// 快照控制 MAILAGENT_BACKEND; useRestartStore 真 store (断言 markRestartRequired)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import type { FolderDiscoverResult } from '../../src/shared/api/types'

await i18n.changeLanguage('zh-CN')

// ── mailApi mock ──────────────────────────────────────────────────────────
// 🔴 必须返回稳定单例 — 真 useMailApi 是 makeMailApi() 单例; 若每次 render 返回新
// 对象, FolderPicker 的 refresh=useCallback([mailApi]) 会每帧重建 → mount effect
// [envGated, refresh] 每帧重跑 → setState('loading') → 死循环 (复刻真实 bug 风险)。
const mockDiscover = vi.fn<[], Promise<FolderDiscoverResult>>()
const mockSetWhitelist = vi.fn()
const stableApi = { folder: { discover: mockDiscover, setWhitelist: mockSetWhitelist } }

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableApi
}))

// ── toast mock (避免真 toast store 副作用) ──────────────────────────────────
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@shared/state/toast', () => ({
  toastSuccess: (...a: unknown[]) => toastSuccess(...a),
  toastError: (...a: unknown[]) => toastError(...a)
}))

import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { FolderPicker } from '../../src/shared/components/settings/parts/FolderPicker'

/** 注入 env store ready 快照, 控制 MAILAGENT_BACKEND。 */
function setBackend(backend: string): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        values: backend ? { MAILAGENT_BACKEND: backend } : {},
        secretKeys: []
      } as never
    }
  })
}

function discoverResult(overrides?: Partial<FolderDiscoverResult>): FolderDiscoverResult {
  return {
    folders: [
      {
        imap_name: 'INBOX',
        display_name: '收件箱',
        delimiter: '/',
        special_use: null,
        is_system: true,
        has_children: false,
        parent: null,
        message_count: 100,
        is_synced: false
      },
      {
        imap_name: 'Jira',
        display_name: 'Jira',
        delimiter: '/',
        special_use: null,
        is_system: false,
        has_children: false,
        parent: null,
        message_count: 3458,
        is_synced: false
      },
      {
        imap_name: 'DMS&VvpO9lPRXgM-',
        display_name: 'DMS固件发布',
        delimiter: '/',
        special_use: null,
        is_system: false,
        has_children: false,
        parent: null,
        message_count: 728,
        is_synced: true
      }
    ],
    tree: [
      {
        imap_name: 'INBOX',
        display_name: '收件箱',
        delimiter: '/',
        special_use: null,
        is_system: true,
        has_children: false,
        parent: null,
        message_count: 100,
        children: []
      },
      {
        imap_name: 'Jira',
        display_name: 'Jira',
        delimiter: '/',
        special_use: null,
        is_system: false,
        has_children: false,
        parent: null,
        message_count: 3458,
        children: []
      },
      {
        imap_name: 'DMS&VvpO9lPRXgM-',
        display_name: 'DMS固件发布',
        delimiter: '/',
        special_use: null,
        is_system: false,
        has_children: false,
        parent: null,
        message_count: 728,
        children: []
      }
    ],
    whitelist: ['DMS&VvpO9lPRXgM-'],
    ...overrides
  }
}

beforeEach(() => {
  mockDiscover.mockReset()
  mockSetWhitelist.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  useRestartStore.setState({ required: false, changedKeys: [] })
  setBackend('davmail')
})

afterEach(() => cleanup())

describe('FolderPicker — 多文件夹选择器', () => {
  test('davmail 后端: 拉取 discover → 树渲染文件夹名 + 计数', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    render(<FolderPicker />)
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('Jira')).toBeTruthy()
    expect(screen.getByText('DMS固件发布')).toBeTruthy()
    // 计数 (mono, en-US 千分位)。
    expect(screen.getByText('3,458')).toBeTruthy()
    // 系统文件夹展示「系统 · 始终同步」状态。
    expect(screen.getByText('收件箱')).toBeTruthy()
  })

  test('勾选自定义文件夹 → 保存调 setWhitelist + 标记 restart', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockSetWhitelist.mockResolvedValue({
      folders: ['DMS&VvpO9lPRXgM-', 'Jira'],
      restart_required: true
    })
    render(<FolderPicker />)
    await screen.findByText('Jira')

    // 勾 Jira (初始未选)。其 checkbox aria-label = display_name。
    const jiraCheckbox = screen.getByRole('checkbox', { name: 'Jira' })
    fireEvent.click(jiraCheckbox)

    // 保存按钮此时应可用 (dirty)。
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => expect(mockSetWhitelist).toHaveBeenCalledTimes(1))
    // 入参含原有 DMS + 新勾 Jira (顺序不强求, 用 Set 断言)。
    const arg = mockSetWhitelist.mock.calls[0][0] as string[]
    expect(new Set(arg)).toEqual(new Set(['DMS&VvpO9lPRXgM-', 'Jira']))
    // restart_required → markRestartRequired(['SYNC_FOLDERS'])。
    await waitFor(() => expect(useRestartStore.getState().required).toBe(true))
    expect(useRestartStore.getState().changedKeys).toContain('SYNC_FOLDERS')
    expect(toastSuccess).toHaveBeenCalled()
  })

  test('系统文件夹不可勾选 (无 checkbox, 只有 lock)', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    render(<FolderPicker />)
    await screen.findByText('收件箱')
    // 系统文件夹 (收件箱) 不应有 role=checkbox; 只有自定义文件夹 (Jira) 有。
    const checkboxes = screen.getAllByRole('checkbox')
    const labels = checkboxes.map((c) => c.getAttribute('aria-label'))
    expect(labels).toContain('Jira')
    expect(labels).not.toContain('收件箱')
  })

  test('保存按钮在无改动时禁用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    render(<FolderPicker />)
    await screen.findByText('Jira')
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })

  test('空态: tree 为空 → 引导文案 + 不渲染保存', async () => {
    mockDiscover.mockResolvedValue(discoverResult({ folders: [], tree: [], whitelist: [] }))
    render(<FolderPicker />)
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('没有可同步的自定义文件夹')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  test('门控态: 非 davmail 后端 → veil + 不发 discover', async () => {
    setBackend('applescript')
    render(<FolderPicker />)
    expect(await screen.findByText('需要 davmail 后端')).toBeTruthy()
    // env 门控时不应发 discover 请求。
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  test('门控态: discover 返回 E_INVALID_ARG → veil', async () => {
    // env 未知 (空 backend) → 乐观放行, 靠 discover 的 400 兜底门控。
    setBackend('')
    const err = Object.assign(new Error('需要 davmail 后端'), { code: 'E_INVALID_ARG' })
    mockDiscover.mockRejectedValue(err)
    render(<FolderPicker />)
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('需要 davmail 后端')).toBeTruthy()
  })
})
