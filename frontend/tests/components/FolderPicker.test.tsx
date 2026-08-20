// @vitest-environment happy-dom
//
// 多文件夹同步 (P3 + P4) — FolderPicker 组件测。
//
// 覆盖: 拉取(discover→树渲染) / 勾选(toggle imap_name) / 保存(setWhitelist 调用 +
// restart 标记) / 门控(env MAILAGENT_BACKEND≠davmail → veil + 不发 discover) /
// 空态(tree 为空 → 引导文案)。
//
// P4 管理操作覆盖: ⋯ 菜单 / 系统文件夹禁用 / 删除确认弹窗 / rename inline /
// createFolder / renameFolder / deleteFolder 调用断言 / restart_required 接线。
//
// useMailApi.folder.discover/setWhitelist/createFolder/renameFolder/deleteFolder
// 用 vi.fn mock; useEnvStore 注入 ready 快照控制 MAILAGENT_BACKEND;
// useRestartStore 真 store (断言 markRestartRequired)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '../../src/shared/i18n'
import type {
  FolderCleanupResult,
  FolderDiscoverResult,
  FolderManageResult,
  FolderPref,
  FolderPrefPatch,
  FolderPrefsResult
} from '../../src/shared/api/types'

await i18n.changeLanguage('zh-CN')

// ── mailApi mock ──────────────────────────────────────────────────────────
// 🔴 必须返回稳定单例 — 真 useMailApi 是 makeMailApi() 单例; 不稳定的 queryFn 闭包
// 不影响 React Query 缓存 (按 queryKey 索引), 但稳定单例仍是真实语义的忠实复刻。
// discover 现走 React Query (['folder','discover'], 与 SidebarFolderTree 共用), 防
// 重复拉取由 staleTime 承担 — 同一 QueryClient 内重 mount 命中缓存零请求。
const mockDiscover = vi.fn<() => Promise<FolderDiscoverResult>>()
const mockSetWhitelist = vi.fn()
const mockCreateFolder =
  vi.fn<(parentImapName: string | null, name: string) => Promise<FolderManageResult>>()
const mockRenameFolder = vi.fn<(imapName: string, newName: string) => Promise<FolderManageResult>>()
const mockDeleteFolder = vi.fn<(imapName: string) => Promise<FolderManageResult>>()
const mockCleanup = vi.fn<(imapName: string) => Promise<FolderCleanupResult>>()
// per-folder 配置 (v62). getPrefs 默认返回空 prefs — 白名单成员取不到行 = 全默认
// (兜底图标 / 通知关 / AI 开), **不是错误**, 这正是真实首次进页面的形状。
const mockGetPrefs = vi.fn<() => Promise<FolderPrefsResult>>()
const mockSetPref = vi.fn<(imapName: string, patch: FolderPrefPatch) => Promise<FolderPref>>()
const stableApi = {
  folder: {
    discover: mockDiscover,
    setWhitelist: mockSetWhitelist,
    createFolder: mockCreateFolder,
    renameFolder: mockRenameFolder,
    deleteFolder: mockDeleteFolder,
    cleanup: mockCleanup,
    getPrefs: mockGetPrefs,
    setPref: mockSetPref
  }
}

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
  mockCreateFolder.mockReset()
  mockRenameFolder.mockReset()
  mockDeleteFolder.mockReset()
  mockCleanup.mockReset()
  mockGetPrefs.mockReset()
  mockGetPrefs.mockResolvedValue({ prefs: [] })
  mockSetPref.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  useRestartStore.setState({ required: false, changedKeys: [] })
  setBackend('davmail')
})

afterEach(() => cleanup())

// FolderPicker 现用 React Query (['folder','discover']) + useQueryClient() 失效共享
// ['folder'] 缓存 → 必须包 provider。可传入共享 QueryClient 验证跨 mount 缓存复用。
function makeQc(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
}
function renderPicker(qc: QueryClient = makeQc()): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={qc}>
      <FolderPicker />
    </QueryClientProvider>
  )
}

describe('FolderPicker — 多文件夹选择器', () => {
  test('davmail 后端: 拉取 discover → 树渲染文件夹名 + 计数', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('Jira')).toBeTruthy()
    // 🔴 getAllByText: 已勾选的文件夹在树里出现一次、在下方「已同步文件夹」配置段
    // 再出现一次 (v62 per-folder 配置行), 两处都是真行。
    expect(screen.getAllByText('DMS固件发布').length).toBeGreaterThanOrEqual(1)
    // 计数 (mono, en-US 千分位)。
    expect(screen.getByText('3,458')).toBeTruthy()
    // 系统文件夹展示「系统 · 始终同步」状态 (「收件箱」同时也是只读内建邮箱段的一行)。
    expect(screen.getAllByText('收件箱').length).toBeGreaterThanOrEqual(1)
  })

  test('共享 QueryClient: 重进设置页命中缓存 → 不再发 discover (零请求)', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    const qc = makeQc()
    // 首次打开 → 拉一次 discover。
    const first = renderPicker(qc)
    await screen.findByText('Jira')
    expect(mockDiscover).toHaveBeenCalledTimes(1)
    // 关闭设置页 (卸载 picker)。
    first.unmount()
    // 重新打开 (同一 QueryClient, staleTime 10min 内) → 命中缓存, 直接渲染零请求。
    renderPicker(qc)
    expect(await screen.findByText('Jira')).toBeTruthy()
    // 仍然只调过一次 discover (缓存复用, 无重复 IMAP STATUS 扫描)。
    expect(mockDiscover).toHaveBeenCalledTimes(1)
  })

  test('手动刷新按钮 → refetch discover (再发一次请求)', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await screen.findByText('Jira')
    expect(mockDiscover).toHaveBeenCalledTimes(1)
    // 点「刷新」→ 强制 refetch (即便 staleTime 未过期)。
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2))
  })

  test('勾选自定义文件夹 → 保存调 setWhitelist + 标记 restart', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockSetWhitelist.mockResolvedValue({
      folders: ['DMS&VvpO9lPRXgM-', 'Jira'],
      restart_required: true
    })
    renderPicker()
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
    renderPicker()
    await screen.findAllByText('收件箱')
    // 系统文件夹 (收件箱) 不应有 role=checkbox; 只有自定义文件夹 (Jira) 有。
    const checkboxes = screen.getAllByRole('checkbox')
    const labels = checkboxes.map((c) => c.getAttribute('aria-label'))
    expect(labels).toContain('Jira')
    expect(labels).not.toContain('收件箱')
  })

  // ── 排序 task: 数组序 = 自定义显示顺序 ──────────────────────────────────
  test('新勾选的文件夹追加到顺序末尾', async () => {
    mockDiscover.mockResolvedValue(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-'] }))
    mockSetWhitelist.mockResolvedValue({
      folders: ['DMS&VvpO9lPRXgM-', 'Jira'],
      restart_required: true
    })
    renderPicker()
    await screen.findByText('Jira')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Jira' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSetWhitelist).toHaveBeenCalledTimes(1))
    // 顺序有语义: 原有项保持在前, 新勾选追加末尾。
    expect(mockSetWhitelist.mock.calls[0][0]).toEqual(['DMS&VvpO9lPRXgM-', 'Jira'])
  })

  // v62 起这一段不只是「顺序」: 单个文件夹也要能换图标 / 配两个开关, 所以判据从
  // 「≥2 项才渲染」放宽到「≥1 项就渲染」; 一个都没勾才整段不出现。
  test('已同步文件夹段: 白名单空 → 不渲染; 1 项 → 渲染 (单项也要配图标/开关)', async () => {
    mockDiscover.mockResolvedValue(discoverResult({ whitelist: [] }))
    const { unmount } = renderPicker()
    await screen.findByText('Jira')
    expect(screen.queryByText('已同步文件夹')).toBeNull()
    unmount()

    mockDiscover.mockResolvedValue(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-'] }))
    renderPicker(makeQc())
    expect(await screen.findByText('已同步文件夹')).toBeTruthy()
  })

  test('键盘重排 (仅顺序变) → 保存钮亮 + 提示"立即生效" + 入参为新序', async () => {
    mockDiscover.mockResolvedValue(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-', 'Jira'] }))
    mockSetWhitelist.mockResolvedValue({
      folders: ['Jira', 'DMS&VvpO9lPRXgM-'],
      restart_required: false
    })
    renderPicker()
    await screen.findByText('已同步文件夹')

    // 无改动时保存禁用。
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)

    // 走 a11y 键盘路径重排: 抓起第 1 项 → ↓ 移到第 2 位。
    const grips = screen
      .getAllByRole('button')
      .filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('调整'))
    expect(grips.length).toBe(2)
    fireEvent.keyDown(grips[0], { key: ' ' })
    fireEvent.keyDown(grips[0], { key: 'ArrowDown' })

    // dirty 是**有序**比较 → 仅调序也点亮保存。
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false))
    // 集合未变 → 文案是「立即生效」而非「需重启」。
    expect(screen.getByText('仅调整显示顺序，保存后立即生效')).toBeTruthy()
    expect(screen.queryByText('保存后需重启同步服务生效')).toBeNull()

    fireEvent.click(saveBtn)
    await waitFor(() => expect(mockSetWhitelist).toHaveBeenCalledTimes(1))
    expect(mockSetWhitelist.mock.calls[0][0]).toEqual(['Jira', 'DMS&VvpO9lPRXgM-'])
    // restart_required=false → 不标记重启。
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(useRestartStore.getState().required).toBe(false)
  })

  // ── re-seed 与未保存编辑（owner dogfood: 「未保存时切出去切回来顺序变回去了」）──
  //
  // 顺序要点「保存」才落盘, 而 react-query 的 dataUpdatedAt **每次 fetch 成功都会变**,
  // 哪怕数据一模一样 —— 于是拖完没保存这段时间里任何一次 discover 刷新 (窗口重新聚焦 /
  // staleTime 过期 / 别处 invalidate) 都会把本地顺序打回旧序。

  /** 顺序列表当前渲染出来的顺序 (DragReorderList 的行, data-id = imap_name)。 */
  const orderShown = (): string[] =>
    [...document.querySelectorAll('[data-reorder-item]')].map((r) => r.getAttribute('data-id')!)

  /** 走 a11y 键盘路径把第 index 项往下移一格。 */
  function reorderDown(index: number): void {
    const grips = screen
      .getAllByRole('button')
      .filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('调整'))
    fireEvent.keyDown(grips[index], { key: ' ' })
    fireEvent.keyDown(grips[index], { key: 'ArrowDown' })
  }

  test('🔴 未保存时 discover 刷新 (数据没变, 只有 dataUpdatedAt 变了) → 本地顺序不许被打回旧序', async () => {
    // 第二次 discover 白名单一字不差, 只有 Jira 的计数变了 —— 拿它当「刷新确实落地并
    // 重渲染了」的证据, 否则断言可能赶在 re-seed 之前跑完, 闸变成空转。
    const second = discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-', 'Jira'] })
    second.folders[1].message_count = 3459
    second.tree[1].message_count = 3459
    mockDiscover
      .mockResolvedValueOnce(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-', 'Jira'] }))
      .mockResolvedValue(second)
    renderPicker()
    await screen.findByText('已同步文件夹')
    expect(orderShown()).toEqual(['DMS&VvpO9lPRXgM-', 'Jira'])

    reorderDown(0)
    expect(orderShown()).toEqual(['Jira', 'DMS&VvpO9lPRXgM-'])

    // 刷新 = 与「切出去切回来 / 窗口重新聚焦 / 别处 invalidate」同一条 re-seed 路径。
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('3,459')).toBeTruthy()

    // 用户拖的顺序还在, 保存钮还亮着 (还没落盘)。
    expect(orderShown()).toEqual(['Jira', 'DMS&VvpO9lPRXgM-'])
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('保存成功后 baseline 推进 → 之后后端再改白名单, 刷新仍能 seed 进来', async () => {
    mockDiscover
      .mockResolvedValueOnce(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-', 'Jira'] }))
      // 保存后的 invalidate→refetch: 后端已是新序。
      .mockResolvedValueOnce(discoverResult({ whitelist: ['Jira', 'DMS&VvpO9lPRXgM-'] }))
      // 再之后别处 (另一端 / 手改 .env) 把顺序改回去了。
      .mockResolvedValue(discoverResult({ whitelist: ['DMS&VvpO9lPRXgM-', 'Jira'] }))
    mockSetWhitelist.mockResolvedValue({
      folders: ['Jira', 'DMS&VvpO9lPRXgM-'],
      restart_required: false
    })
    renderPicker()
    await screen.findByText('已同步文件夹')

    reorderDown(0)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSetWhitelist).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(
        true
      )
    )

    // 保存已落盘 ⇒ 不再是「未保存的编辑」, 后端的新白名单必须能 seed 进来。
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(orderShown()).toEqual(['DMS&VvpO9lPRXgM-', 'Jira']))
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('保存按钮在无改动时禁用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await screen.findByText('Jira')
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true)
  })

  test('空态: tree 为空 → 引导文案 + 不渲染保存', async () => {
    mockDiscover.mockResolvedValue(discoverResult({ folders: [], tree: [], whitelist: [] }))
    renderPicker()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('没有可同步的自定义文件夹')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  test('门控态: 非 davmail 后端 → veil + 不发 discover', async () => {
    setBackend('applescript')
    renderPicker()
    expect(await screen.findByText('需要 davmail 后端')).toBeTruthy()
    // env 门控时不应发 discover 请求。
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  test('门控态: discover 返回 E_INVALID_ARG → veil', async () => {
    // env 未知 (空 backend) → 乐观放行, 靠 discover 的 400 兜底门控。
    setBackend('')
    const err = Object.assign(new Error('需要 davmail 后端'), { code: 'E_INVALID_ARG' })
    mockDiscover.mockRejectedValue(err)
    renderPicker()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    expect(await screen.findByText('需要 davmail 后端')).toBeTruthy()
  })
})

// ── P4 管理操作 ───────────────────────────────────────────────────────────
describe('FolderPicker — P4 管理操作', () => {
  test('自定义文件夹 ⋯ 按钮点击后出现菜单 (新建子文件夹 / 重命名 / 删除)', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await screen.findByText('Jira')

    // 点击 Jira 行的 ⋯ 管理菜单按钮 (aria-label = '管理文件夹' 有多个, 取第一个可用的)。
    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    // 系统文件夹的 ⋯ 按钮是 disabled; 找第一个非 disabled 的 (= Jira 行)。
    const customMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)
    expect(customMenuBtn).toBeTruthy()
    fireEvent.click(customMenuBtn!)

    // 菜单应渲染三项。
    expect(screen.getByRole('menuitem', { name: /新建子文件夹/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /重命名/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /删除/ })).toBeTruthy()
  })

  test('系统文件夹 ⋯ 按钮 disabled (不可管理)', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await screen.findAllByText('收件箱')

    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    // 系统文件夹 (收件箱) 排在第一位 (树中第一行), 其 ⋯ 按钮应 disabled。
    const inboxMenuBtn = menuBtns[0] as HTMLButtonElement
    expect(inboxMenuBtn.disabled).toBe(true)
  })

  test('删除流程: 点删除 → 弹确认 modal → 确认 → deleteFolder 被调用 + toast', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    // 删除成功后会再次 discover (refetch), 给第二次 discover 返回值。
    mockDiscover
      .mockResolvedValueOnce(discoverResult())
      .mockResolvedValueOnce(discoverResult({ whitelist: [] }))
    mockDeleteFolder.mockResolvedValue({ imap_name: 'Jira', restart_required: false })

    renderPicker()
    await screen.findByText('Jira')

    // 打开 Jira 的 ⋯ 菜单。
    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)

    // 点击「删除」。
    const deleteItem = screen.getByRole('menuitem', { name: /删除/ })
    fireEvent.click(deleteItem)

    // 确认 modal 应出现 (role=dialog, aria-modal=true)。
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    // 点「删除文件夹」确认按钮。
    const confirmBtn = screen.getByRole('button', { name: /删除文件夹/ })
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(mockDeleteFolder).toHaveBeenCalledWith('Jira'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  test('删除流程: 取消 → deleteFolder 未被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    renderPicker()
    await screen.findByText('Jira')

    // 打开菜单 → 点删除 → modal 出现。
    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))
    await screen.findByRole('dialog')

    // 点取消。
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    // modal 应消失。
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // deleteFolder 不应被调用。
    expect(mockDeleteFolder).not.toHaveBeenCalled()
  })

  test('重命名流程: 点重命名 → inline 输入 → 提交 → renameFolder 被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockDiscover.mockResolvedValueOnce(discoverResult()).mockResolvedValueOnce(discoverResult())
    mockRenameFolder.mockResolvedValue({ imap_name: 'Jira', restart_required: false })

    renderPicker()
    await screen.findByText('Jira')

    // 打开 Jira 的 ⋯ 菜单 → 点重命名。
    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))

    // inline 输入应出现 (预填当前名 'Jira')。
    const input = await screen.findByDisplayValue('Jira')
    expect(input).toBeTruthy()

    // 改名。
    fireEvent.change(input, { target: { value: 'Jira-renamed' } })

    // 找到 check 确认按钮 (title/aria 无, 用 type=button + 包含 svg 的 check 按钮)。
    // InlineEditRow 中确认按钮不在 '管理文件夹' group, 用 closest form 或直接 Enter。
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledWith('Jira', 'Jira-renamed'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  test('新建子文件夹流程: 点新建子文件夹 → inline 输入 → 提交 → createFolder 被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockDiscover.mockResolvedValueOnce(discoverResult()).mockResolvedValueOnce(discoverResult())
    mockCreateFolder.mockResolvedValue({ imap_name: 'Jira/Sub', restart_required: false })

    renderPicker()
    await screen.findByText('Jira')

    // 打开 Jira 的 ⋯ 菜单 → 点新建子文件夹。
    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /新建子文件夹/ }))

    // inline 新建输入应出现 (空值 placeholder)。
    const input = await screen.findByPlaceholderText('子文件夹名称')
    expect(input).toBeTruthy()

    fireEvent.change(input, { target: { value: 'SubFolder' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFolder).toHaveBeenCalledWith('Jira', 'SubFolder'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  test('rename restart_required=true → markRestartRequired 被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockDiscover.mockResolvedValueOnce(discoverResult()).mockResolvedValueOnce(discoverResult())
    // 后端返回 restart_required=true。
    mockRenameFolder.mockResolvedValue({ imap_name: 'Jira', restart_required: true })

    renderPicker()
    await screen.findByText('Jira')

    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }))

    const input = await screen.findByDisplayValue('Jira')
    fireEvent.change(input, { target: { value: 'Jira-new' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockRenameFolder).toHaveBeenCalled())
    // restart_required=true → markRestartRequired(['SYNC_FOLDERS']) 被调用。
    await waitFor(() => expect(useRestartStore.getState().required).toBe(true))
    expect(useRestartStore.getState().changedKeys).toContain('SYNC_FOLDERS')
  })

  test('delete restart_required=true → markRestartRequired 被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockDiscover
      .mockResolvedValueOnce(discoverResult())
      .mockResolvedValueOnce(discoverResult({ whitelist: [] }))
    // 后端返回 restart_required=true。
    mockDeleteFolder.mockResolvedValue({ imap_name: 'Jira', restart_required: true })

    renderPicker()
    await screen.findByText('Jira')

    const menuBtns = screen.getAllByRole('button', { name: '管理文件夹' })
    const jiraMenuBtn = menuBtns.find((b) => !(b as HTMLButtonElement).disabled)!
    fireEvent.click(jiraMenuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }))

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /删除文件夹/ }))

    await waitFor(() => expect(mockDeleteFolder).toHaveBeenCalled())
    // restart_required=true → markRestartRequired(['SYNC_FOLDERS']) 被调用。
    await waitFor(() => expect(useRestartStore.getState().required).toBe(true))
    expect(useRestartStore.getState().changedKeys).toContain('SYNC_FOLDERS')
  })

  // ── P5 本地副本清理 ────────────────────────────────────────────────────────
  test('P5 取消勾选已同步文件夹 → 出现清理提示; 点「清理」→ cleanup 被调用 + toast + restart', async () => {
    // DMS&VvpO9lPRXgM- 在 whitelist 中 (is_synced), 取消勾选后应出现清理提示。
    mockDiscover.mockResolvedValue(discoverResult())
    // cleanup 成功后会 refetch discover (第二次调用)。
    mockDiscover
      .mockResolvedValueOnce(discoverResult())
      .mockResolvedValueOnce(discoverResult({ whitelist: [] }))
    mockCleanup.mockResolvedValue({
      imap_name: 'DMS&VvpO9lPRXgM-',
      affected_local_rows: 42,
      restart_required: true
    })

    renderPicker()
    await screen.findAllByText('DMS固件发布')

    // DMS固件发布 初始已选中 (在 whitelist) — 取消勾选。
    const dmsCheckbox = screen.getByRole('checkbox', { name: 'DMS固件发布' })
    fireEvent.click(dmsCheckbox)

    // 清理提示应出现 (role=group with cleanup aria-label or text content)。
    // 取文案「也清理本地副本？」所在区域。
    await waitFor(() => expect(screen.queryByText('728')).toBeTruthy()) // count still visible
    // 点「清理」按钮。
    const cleanupBtn = await screen.findByRole('button', { name: /清理/ })
    fireEvent.click(cleanupBtn)

    await waitFor(() => expect(mockCleanup).toHaveBeenCalledWith('DMS&VvpO9lPRXgM-'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    // restart_required=true → markRestartRequired(['SYNC_FOLDERS'])。
    await waitFor(() => expect(useRestartStore.getState().required).toBe(true))
    expect(useRestartStore.getState().changedKeys).toContain('SYNC_FOLDERS')
  })

  test('P5 取消勾选已同步文件夹 → 点「保留」→ cleanup 未被调用', async () => {
    mockDiscover.mockResolvedValue(discoverResult())

    renderPicker()
    await screen.findAllByText('DMS固件发布')

    // 取消勾选 DMS固件发布 (在 whitelist, 应出现清理提示)。
    const dmsCheckbox = screen.getByRole('checkbox', { name: 'DMS固件发布' })
    fireEvent.click(dmsCheckbox)

    // 点「保留」→ 清理提示消失, cleanup 不调用。
    const keepBtn = await screen.findByRole('button', { name: '保留' })
    fireEvent.click(keepBtn)

    // 提示消失。
    await waitFor(() => expect(screen.queryByRole('button', { name: '保留' })).toBeNull())
    // cleanup 未被调用。
    expect(mockCleanup).not.toHaveBeenCalled()
  })
})

// ── per-folder 配置 (v62, folder_pref) —— 图标 + 两个开关 ────────────────────
//
// 🔴 本段的核心是**极性**: 「AI 分类」开关与落库列 `llm_disabled` 反向 (黑名单语义),
// 「通知」与 `notify_enabled` 同向 (白名单语义)。写反了界面看着对、行为全反 ——
// 所以断言看的是 setPref 的**入参**, 不是开关的视觉态。
describe('FolderPicker — per-folder 配置 (v62)', () => {
  beforeEach(() => {
    mockDiscover.mockResolvedValue(discoverResult())
    mockSetPref.mockResolvedValue({
      imap_name: 'DMS&VvpO9lPRXgM-',
      mailbox_label: 'DMS固件发布',
      icon: null,
      notify_enabled: false,
      llm_disabled: false,
      updated_at: 0
    })
  })

  test('「通知」开关 (白名单语义, 与 notify_enabled 同向): 开 → notify_enabled=true', async () => {
    renderPicker()
    await screen.findByText('已同步文件夹')
    fireEvent.click(screen.getByRole('switch', { name: 'DMS固件发布 通知' }))
    await waitFor(() =>
      expect(mockSetPref).toHaveBeenCalledWith('DMS&VvpO9lPRXgM-', { notify_enabled: true })
    )
  })

  // 🔴 同步断言 (click 之后不 await 任何东西): 开关必须**当场**翻, 而不是等 PUT 回来 +
  // invalidate 重拉。少了乐观更新, 远程 web 上点下去有一个来回的空窗, 用户会以为没生效
  // 而连点。用 waitFor 写这条会被随后的 refetch 蒙混过去, 变成恒绿装饰。
  test('点开关当场翻 (乐观更新), 不等 PUT 往返', async () => {
    renderPicker()
    await screen.findByText('已同步文件夹')
    const notify = screen.getByRole('switch', { name: 'DMS固件发布 通知' })
    expect(notify.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(notify)
    expect(
      screen.getByRole('switch', { name: 'DMS固件发布 通知' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  test('🔴「AI 分类」开关与 llm_disabled **反向**: 关掉 AI → llm_disabled=true', async () => {
    renderPicker()
    await screen.findByText('已同步文件夹')
    // 缺省 = 跑 LLM (llm_disabled 缺省 false) ⇒ 开关初始就是开的, 这一下是「关掉」。
    const ai = screen.getByRole('switch', { name: 'DMS固件发布 AI' })
    expect(ai.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(ai)
    await waitFor(() =>
      expect(mockSetPref).toHaveBeenCalledWith('DMS&VvpO9lPRXgM-', { llm_disabled: true })
    )
  })

  test('内建 5 行不给开关: 只有自定义文件夹有 switch, 内建位是 10 个「不适用」', async () => {
    renderPicker()
    await screen.findByText('已同步文件夹')
    // 白名单里只有 1 个自定义文件夹 ⇒ 全页只有它那 2 个开关。
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    // 内建 5 行 × 2 列 = 10 个「—」位 (不是「关」: 后端 gate 对标准邮箱直接短路)。
    expect(screen.getAllByLabelText('不适用')).toHaveLength(10)
  })

  test('图标选择器: 选一个 → setPref({icon: key}); 「默认」→ setPref({icon: null})', async () => {
    renderPicker()
    await screen.findByText('已同步文件夹')

    fireEvent.click(screen.getByRole('button', { name: '更换「DMS固件发布」的图标' }))
    const dialog = await screen.findByRole('dialog', { name: '为「DMS固件发布」选择图标' })
    // 24 个候选全在。
    expect(screen.getAllByRole('option')).toHaveLength(24)

    fireEvent.click(screen.getByRole('option', { name: /^folder-check/ }))
    await waitFor(() =>
      expect(mockSetPref).toHaveBeenCalledWith('DMS&VvpO9lPRXgM-', { icon: 'folder-check' })
    )
    // 选完弹层收起。
    await waitFor(() => expect(dialog.isConnected).toBe(false))

    // 「恢复默认」= 清空 icon 列 → 走 patch 的 icon: null (不是省略该字段, 那是「保持不变」)。
    mockSetPref.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '更换「DMS固件发布」的图标' }))
    await screen.findByRole('dialog', { name: '为「DMS固件发布」选择图标' })
    fireEvent.click(screen.getByRole('button', { name: '默认' }))
    await waitFor(() =>
      expect(mockSetPref).toHaveBeenCalledWith('DMS&VvpO9lPRXgM-', { icon: null })
    )
  })

  test('setPref 失败 → toast 报错, 不静默吞', async () => {
    mockSetPref.mockRejectedValue(new Error('boom'))
    renderPicker()
    await screen.findByText('已同步文件夹')
    fireEvent.click(screen.getByRole('switch', { name: 'DMS固件发布 通知' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
