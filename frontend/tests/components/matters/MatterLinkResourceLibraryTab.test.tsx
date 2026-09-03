// @vitest-environment happy-dom
//
// P2-L10（资料库 epic，design §9.2「三条入口，安全姿态各异」的第 ① 条）——
// 「关联资料」弹窗的第四 tab「资料库」。
//
// 这里盯的是四件会静默错掉的事：
//   · 落库形状：库文件与邮件附件同为 `kind='file'`、同在 mailagent 身份空间，唯一区分是
//     `external_key` 前缀。写成 `attachment:` 前缀不会报错，只会在事项上挂出一份点不开、
//     且与真实附件抢同一把唯一键的资料（`uq_resource_provider_key` 不含 kind）。
//   · 逐条串行 + 用上一条返回的 version：并发发出去必然自撞乐观锁（与邮件/附件两 lane 同
//     一个病根，见 modal 里那段注释）。
//   · 投影行（`mail-attachments` 下的邮件附件）`id` 恒 null —— 关联键构造不出来，必须在
//     结果里就剔掉，否则会出现一行勾得上、提交时静默丢掉的候选。
//   · `warnings` 是**数组**：中文 1 字 query 服务端只回 warning 不回结果，UI 要说出那句
//     「至少输入 2 个字」，而不是显示「没有匹配的文件」让人以为库里真没有。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterResourceListItem } from '@shared/api/types/matter'
import type { LibrarySearchHit, LibrarySearchResponse } from '@shared/api/types/library'

const { mattersApi, mailApi, librarySearch, toastSuccess } = vi.hoisted(() => ({
  mattersApi: {
    listResourceCandidates: vi.fn(),
    listResourceAttachments: vi.fn(),
    linkResource: vi.fn()
  },
  mailApi: { email: { list: vi.fn(), search: vi.fn() } },
  librarySearch: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({ useMattersApi: () => mattersApi }))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/hooks/useConnectorQuickRows', () => ({
  useConnectorQuickRows: () => ({ rows: [], available: false, anyActive: false })
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  fetchConnectorToolsEnabled: vi.fn(async () => false),
  resolveApiBaseUrl: () => 'http://127.0.0.1:8765/api'
}))
vi.mock('@shared/api/library', () => ({ createLibraryApi: () => ({ search: librarySearch }) }))
vi.mock('@shared/components/matters/useMatterUndoToast', () => ({
  useMatterUndoToast: () => vi.fn()
}))
vi.mock('@shared/state/toast', () => ({
  toastSuccess,
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  useToastStore: { getState: () => ({ push: vi.fn(), dismiss: vi.fn() }) }
}))

const { MatterLinkResourceModal } =
  await import('@shared/components/matters/MatterLinkResourceModal')

await i18n.changeLanguage('zh-CN')

const matter = { public_id: 'MAT-0001', version: 3, title: 'Ours' } as unknown as Matter

function fileHit(overrides: Partial<LibrarySearchHit> = {}): LibrarySearchHit {
  return {
    id: 302,
    mount_id: 0,
    rel_path: '产品/定价.md',
    path: 'my-docs/产品/定价.md',
    parent_path: 'my-docs/产品',
    filename: '定价.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 4096,
    mtime: 1_756_000_000,
    content_hash: 'h1',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 0,
    updated_at: 0,
    snippet: null,
    rank: 1,
    match: 'text',
    ...overrides
  } as LibrarySearchHit
}

function searchResponse(
  hits: LibrarySearchHit[],
  warnings: string[] = [],
  mode = 'porter'
): LibrarySearchResponse {
  return {
    query: 'q',
    mode,
    search_mode: 'fts',
    semantic: { available: false, model: null, chunks: 0 },
    hits,
    warnings
  }
}

function renderModal(resources: MatterResourceListItem[] = []): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MatterLinkResourceModal
        matter={matter}
        resources={resources}
        open
        initialTab="library"
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />
    </QueryClientProvider>
  )
}

function typeQuery(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('搜索文件名与正文'), { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.listResourceCandidates.mockResolvedValue({ items: [], local_candidate_count: 0 })
  mattersApi.listResourceAttachments.mockResolvedValue([])
  mailApi.email.list.mockResolvedValue([])
  mailApi.email.search.mockResolvedValue({ items: [], total_indexed: 0 })
  librarySearch.mockResolvedValue(searchResponse([]))
})

afterEach(cleanup)

describe('第四 tab「资料库」—— 检索面', () => {
  test('输入关键词 → 防抖后走 GET /library/search，命中行出文件名与路径', async () => {
    librarySearch.mockResolvedValue(searchResponse([fileHit()]))
    renderModal()
    typeQuery('定价')

    await waitFor(() => expect(librarySearch).toHaveBeenCalledTimes(1))
    expect(librarySearch.mock.calls[0][0]).toBe('定价')
    expect(await screen.findByText('定价.md')).toBeTruthy()
    // 副行是「虚拟路径 · 大小」一整串，用子串判而不是全等。
    expect(screen.getByText(/my-docs\/产品\/定价\.md/)).toBeTruthy()
  })

  test('空 query 不发请求（服务端 q 必填，空串是 422 不是空结果），也不谎称库里没文件', async () => {
    renderModal()
    await waitFor(() => expect(mattersApi.listResourceCandidates).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(librarySearch).not.toHaveBeenCalled()
    // 🔴 一个请求都没发的时候说「没有匹配的文件」= 把「还没查」说成「查了没有」，与
    // warning 那条同一个病根。这里只能出「怎么用」。
    expect(screen.queryByText('没有匹配的文件')).toBeNull()
  })

  test('中文 1 字 → 服务端 warning 数组，出「至少输入 2 个字」而不是「没有匹配的文件」', async () => {
    librarySearch.mockResolvedValue(searchResponse([], ['cjk_too_short:定'], 'too_short'))
    renderModal()
    typeQuery('定')

    expect(await screen.findByText('至少输入 2 个字')).toBeTruthy()
    expect(screen.queryByText('没有匹配的文件')).toBeNull()
  })

  test('查得动但没结果 → 空态「没有匹配的文件」', async () => {
    librarySearch.mockResolvedValue(searchResponse([]))
    renderModal()
    typeQuery('不存在的东西')

    expect(await screen.findByText('没有匹配的文件')).toBeTruthy()
  })

  test('🔴 投影行（id 为 null）滤掉 —— 关联键构造不出来，勾得上就是骗人', async () => {
    librarySearch.mockResolvedValue(
      searchResponse([
        fileHit(),
        fileHit({
          id: null,
          filename: '合同扫描件.pdf',
          path: 'mail-attachments/2026-09/合同扫描件.pdf',
          is_projection: true,
          attachment_id: 9182
        })
      ])
    )
    renderModal()
    typeQuery('合同')

    expect(await screen.findByText('定价.md')).toBeTruthy()
    expect(screen.queryByText('合同扫描件.pdf')).toBeNull()
  })

  test('已经挂在本事项上的库文件不再出现在候选里', async () => {
    librarySearch.mockResolvedValue(searchResponse([fileHit(), fileHit({ id: 403, filename: '草案.md' })]))
    renderModal([
      { resource: { external_key: 'library:302' } } as unknown as MatterResourceListItem
    ])
    typeQuery('md')

    expect(await screen.findByText('草案.md')).toBeTruthy()
    expect(screen.queryByText('定价.md')).toBeNull()
  })
})

describe('第四 tab「资料库」—— 落库循环', () => {
  test('两个文件逐条串行，第二条带上第一条返回的 version，键是 library:{id}', async () => {
    librarySearch.mockResolvedValue(searchResponse([fileHit(), fileHit({ id: 403, filename: '草案.md' })]))
    mattersApi.linkResource
      .mockResolvedValueOnce({ matter: { version: 4 }, warnings: [] })
      .mockResolvedValueOnce({ matter: { version: 5 }, warnings: [] })
    renderModal()
    typeQuery('md')

    for (const name of ['定价.md', '草案.md']) {
      const row = (await screen.findByText(name)).closest('label')
      fireEvent.click(row?.querySelector('input[type="checkbox"]') as HTMLInputElement)
    }
    fireEvent.click(screen.getByRole('button', { name: /^关联$/ }))

    await waitFor(() => expect(mattersApi.linkResource).toHaveBeenCalledTimes(2))
    const [firstInput, firstOptions] = mattersApi.linkResource.mock.calls[0].slice(1)
    expect(firstInput).toMatchObject({
      provider: 'mailagent',
      kind: 'file',
      external_key: 'library:302',
      title: '定价.md',
      confirmed: true
    })
    expect(firstOptions.expectedVersion).toBe(3)
    // 🔴 第二条用的是**第一条返回的** version，不是 matter.version + 1 的空想。
    expect(mattersApi.linkResource.mock.calls[1][2].expectedVersion).toBe(4)
    expect(mattersApi.linkResource.mock.calls[1][1].external_key).toBe('library:403')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
  })

  test('sum / cached_excerpt 由服务端填 —— 前端一个字都不发', async () => {
    librarySearch.mockResolvedValue(searchResponse([fileHit()]))
    mattersApi.linkResource.mockResolvedValue({ matter: { version: 4 }, warnings: [] })
    renderModal()
    typeQuery('定价')

    const row = (await screen.findByText('定价.md')).closest('label')
    fireEvent.click(row?.querySelector('input[type="checkbox"]') as HTMLInputElement)
    fireEvent.click(screen.getByRole('button', { name: /^关联$/ }))

    await waitFor(() => expect(mattersApi.linkResource).toHaveBeenCalledTimes(1))
    const input = mattersApi.linkResource.mock.calls[0][1] as Record<string, unknown>
    expect(input.sum).toBeUndefined()
    expect(input.metadata).toBeUndefined()
  })
})
