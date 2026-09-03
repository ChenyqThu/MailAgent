// @vitest-environment happy-dom
//
// 设置页「资料库」区（task 09-03 P2-L6；design §1.5 / §8.2 / §9.1，mockup D2）。三组判据：
//   · 挂载列表是**唯一**显示绝对路径的地方（其它面拿到的类型里根本没有 abs_path 字段）；
//   · 库占用 / 重扫接对了端点；
//   · 语义检索四态，且**下载与建索引是两段进度**——`job.kind` 决定文案与单位（字节 / 文件数）。
//     🔴 服务端下载完会自动接一次建索引，所以「有 job 在跑」≠「在下载」；只按 running 渲染会让
//     用户在建索引阶段一直看到「正在下载模型」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const ABS_PATH = '/Users/someone/Documents/Omada/工作区'

const { api, usageBytes, reveal } = vi.hoisted(() => ({
  api: {
    mounts: vi.fn(),
    addMount: vi.fn(),
    patchMount: vi.fn(),
    removeMount: vi.fn(),
    rescan: vi.fn(),
    embedStatus: vi.fn(),
    embedDownload: vi.fn(),
    embedRebuild: vi.fn()
  },
  usageBytes: vi.fn(),
  reveal: vi.fn()
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/components/library/libraryIpc', () => ({
  libraryUsageBytes: usageBytes,
  revealLibraryTarget: reveal
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ settings: { pickFolder: vi.fn() } })
}))

import i18n from '@shared/i18n'
import type { LibraryEmbedStatus } from '@shared/api/library'
import type { LibraryMount } from '@shared/api/types/library'
import { LibrarySection } from '@shared/components/settings/LibrarySection'

await i18n.changeLanguage('en-US')

function mountRow(over: Partial<LibraryMount> = {}): LibraryMount {
  return {
    id: 7,
    label: '工作区',
    abs_path: ABS_PATH,
    mode: 'rw',
    status: 'ok',
    file_count: 1284,
    added_at: 1_756_000_000,
    ...over
  }
}

function embed(over: Partial<LibraryEmbedStatus> = {}): LibraryEmbedStatus {
  return {
    model: {
      available: false,
      model_id: 'Qwen3-Embedding-0.6B',
      repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
      approx_bytes: 614_000_000,
      bytes_on_disk: 0
    },
    index: { files_total: 4412, files_indexed: 0, files_pending: 4412, chunks: 0 },
    job: null,
    ...over
  }
}

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LibrarySection />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.mounts.mockResolvedValue([mountRow()])
  api.rescan.mockResolvedValue({ scanned: 30, added: 1, updated: 2, missing: 0, elapsed_ms: 40 })
  api.embedStatus.mockResolvedValue(embed())
  usageBytes.mockResolvedValue(1_975_684_956)
})
afterEach(cleanup)

describe('挂载列表 = 绝对路径的唯一露出点', () => {
  test('列出 @label、权限档、文件数与绝对路径', async () => {
    renderSection()
    const path = await screen.findByTestId('library-mount-abs-path')
    expect(path.textContent).toBe(ABS_PATH)
    expect(screen.getByText('@工作区')).toBeTruthy()
    expect(screen.getByText('Writable')).toBeTruthy()
    expect(screen.getByText('1284')).toBeTruthy()
    // 「只在这里显示」这句话本身也得在场，否则读者无从知道别处为什么看不到路径。
    expect(screen.getByText(/absolute path is shown only here/i)).toBeTruthy()
  })

  test('不可用的挂载灰示原因，「在访达中显示」禁用，但仍能卸载', async () => {
    api.mounts.mockResolvedValue([mountRow({ status: 'unavailable' })])
    api.removeMount.mockResolvedValue(mountRow({ status: 'unmounted' }))
    renderSection()

    expect(await screen.findByText(/external volume was unplugged/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Unmount' }))
    await waitFor(() => expect(api.removeMount).toHaveBeenCalledWith(7))
  })
})

describe('库占用与重扫', () => {
  test('库占用来自主进程量出来的字节', async () => {
    renderSection()
    await waitFor(() => expect(usageBytes).toHaveBeenCalled())
    expect(await screen.findByText('1.8 GB')).toBeTruthy()
  })

  test('「重扫资料库」打 POST /library/rescan（全库，不带 mount_id）', async () => {
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /Rescan library/ }))
    await waitFor(() => expect(api.rescan).toHaveBeenCalledWith())
  })
})

describe('语义检索四态', () => {
  test('未下载：说明纯 FTS + 一个下载按钮', async () => {
    renderSection()
    expect(await screen.findByText(/keyword-only search \(FTS5\)/i)).toBeTruthy()
    const button = screen.getByRole('button', { name: /Download semantic model/ })
    api.embedDownload.mockResolvedValue(embed({ job: job('download', 0, 614_000_000) }))
    fireEvent.click(button)
    await waitFor(() => expect(api.embedDownload).toHaveBeenCalled())
  })

  test('下载中：文案是「正在下载模型」，进度按**字节**读', async () => {
    api.embedStatus.mockResolvedValue(embed({ job: job('download', 218_000_000, 614_000_000) }))
    renderSection()

    expect(await screen.findByText('Downloading model')).toBeTruthy()
    expect(screen.getByText('207.9 MB / 585.6 MB')).toBeTruthy()
    // 建索引那一段绝不能同时出现。
    expect(screen.queryByText(/Embedded .* files/)).toBeNull()
  })

  test('建索引中：文案是「重建索引」+ 文件数，**不再说「正在下载」**（下载完会自动接上这一段）', async () => {
    api.embedStatus.mockResolvedValue(
      embed({
        model: { ...embed().model, available: true, bytes_on_disk: 614_000_000 },
        job: job('index', 1820, 4412)
      })
    )
    renderSection()

    expect(await screen.findByText('Embedded 1820 / 4412 files')).toBeTruthy()
    expect(screen.queryByText('Downloading model')).toBeNull()
    // 作业在跑时不给「重建索引」按钮（服务端是进程内单实例，按了也是 409）。
    expect(screen.queryByRole('button', { name: 'Rebuild index' })).toBeNull()
  })

  test('已就绪：模型行 + 重建索引按钮', async () => {
    api.embedStatus.mockResolvedValue(
      embed({
        model: { ...embed().model, available: true, bytes_on_disk: 614_000_000 },
        index: { files_total: 4412, files_indexed: 4412, files_pending: 0, chunks: 51_000 }
      })
    )
    api.embedRebuild.mockResolvedValue(embed({ job: job('index', 0, 4412) }))
    renderSection()

    expect(await screen.findByText(/Model ready/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Download semantic model/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild index' }))
    await waitFor(() => expect(api.embedRebuild).toHaveBeenCalled())
  })

  test('作业失败：原样显示服务端的错误串', async () => {
    api.embedStatus.mockResolvedValue(
      embed({ job: { ...job('download', 0, 614_000_000), running: false, error: 'connection reset' } })
    )
    renderSection()
    expect(await screen.findByText('connection reset')).toBeTruthy()
  })
})

function job(kind: 'download' | 'index', done: number, total: number) {
  return { kind, running: true, done, total, error: null, started_at: 1, finished_at: null }
}
