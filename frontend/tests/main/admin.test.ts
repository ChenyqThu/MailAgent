// Native-only admin IPC handlers contract: admin:dbPath, admin:exportDiagnostics,
// and diagnostics zip helpers shared with handlers/feedback.ts.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli, mockShowSaveDialog, mockIpcHandle, mockCopyFileSync, mockRmSync } = vi.hoisted(
  () => ({
    mockCallCli: vi.fn(),
    mockShowSaveDialog: vi.fn(),
    mockIpcHandle: vi.fn(),
    mockCopyFileSync: vi.fn(),
    mockRmSync: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getVersion: () => '4.0.0' },
  dialog: { showSaveDialog: mockShowSaveDialog },
  ipcMain: { handle: mockIpcHandle }
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    copyFileSync: mockCopyFileSync,
    rmSync: mockRmSync
  }
})

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
    '../../src/electron/main/cli_runner'
  )
  return { ...actual, callCli: mockCallCli }
})

vi.mock('../../src/electron/main/db', () => ({
  resolveDbPath: () => '/tmp/mailagent/sync_store.db'
}))

import {
  buildDiagnosticsZip,
  cleanupDiagnosticsTmp,
  diagnosticsCliArgs,
  registerAdminHandlers,
  runExportDiagnostics
} from '../../src/electron/main/handlers/admin'

beforeEach(() => {
  mockCallCli.mockReset()
  mockShowSaveDialog.mockReset()
  mockIpcHandle.mockReset()
  mockCopyFileSync.mockReset()
  mockRmSync.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('diagnosticsCliArgs', () => {
  test('默认（设置页导出）不带 --no-quick-check', () => {
    expect(diagnosticsCliArgs('4.0.0')).toEqual([
      'admin',
      'export-diagnostics',
      '--app-version',
      '4.0.0'
    ])
    expect(diagnosticsCliArgs('4.0.0', {})).not.toContain('--no-quick-check')
    expect(diagnosticsCliArgs('4.0.0', { quickCheck: true })).not.toContain('--no-quick-check')
  })

  test('quickCheck:false（agent 代发反馈）在末尾追加 --no-quick-check', () => {
    expect(diagnosticsCliArgs('4.0.0', { quickCheck: false })).toEqual([
      'admin',
      'export-diagnostics',
      '--app-version',
      '4.0.0',
      '--no-quick-check'
    ])
  })
})

describe('buildDiagnosticsZip & cleanupDiagnosticsTmp', () => {
  test('builds zip via CLI with 180s timeout and returns zip_path', async () => {
    mockCallCli.mockResolvedValue({ zip_path: '/tmp/diag-123/mailagent-diag.zip' })
    const zipPath = await buildDiagnosticsZip({ quickCheck: false })
    expect(zipPath).toBe('/tmp/diag-123/mailagent-diag.zip')
    expect(mockCallCli).toHaveBeenCalledWith(
      ['admin', 'export-diagnostics', '--app-version', '4.0.0', '--no-quick-check'],
      { timeoutMs: 180_000 }
    )
  })

  test('throws when CLI omits zip_path', async () => {
    mockCallCli.mockResolvedValue({})
    await expect(buildDiagnosticsZip()).rejects.toThrow('export-diagnostics 未返回 zip_path')
  })

  test('cleanupDiagnosticsTmp removes parent directory and swallows fs errors', () => {
    cleanupDiagnosticsTmp('/tmp/diag-123/mailagent-diag.zip')
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/diag-123', { recursive: true, force: true })

    mockRmSync.mockImplementationOnce(() => {
      throw new Error('EPERM')
    })
    expect(() => cleanupDiagnosticsTmp('/tmp/diag-123/mailagent-diag.zip')).not.toThrow()
  })
})

describe('runExportDiagnostics', () => {
  test('saves zip to chosen path and cleans tmp directory', async () => {
    mockCallCli.mockResolvedValue({ zip_path: '/tmp/diag-123/mailagent-diag.zip' })
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/Users/me/Desktop/diag.zip' })

    const res = await runExportDiagnostics()
    expect(res).toEqual({ saved: true, path: '/Users/me/Desktop/diag.zip' })
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      '/tmp/diag-123/mailagent-diag.zip',
      '/Users/me/Desktop/diag.zip'
    )
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/diag-123', { recursive: true, force: true })
  })

  test('cleans tmp and returns saved:false when dialog canceled', async () => {
    mockCallCli.mockResolvedValue({ zip_path: '/tmp/diag-456/mailagent-diag.zip' })
    mockShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const res = await runExportDiagnostics()
    expect(res).toEqual({ saved: false })
    expect(mockCopyFileSync).not.toHaveBeenCalled()
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/diag-456', { recursive: true, force: true })
  })

  test('still cleans tmp directory when copyFileSync throws', async () => {
    mockCallCli.mockResolvedValue({ zip_path: '/tmp/diag-789/mailagent-diag.zip' })
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/readonly/diag.zip' })
    mockCopyFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })

    await expect(runExportDiagnostics()).rejects.toThrow('EACCES')
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/diag-789', { recursive: true, force: true })
  })
})

describe('registerAdminHandlers', () => {
  test('registers only admin:dbPath and admin:exportDiagnostics', async () => {
    registerAdminHandlers()
    const channels = mockIpcHandle.mock.calls.map((c) => c[0] as string)
    expect(channels).toEqual(['admin:dbPath', 'admin:exportDiagnostics'])

    const dbPathHandler = mockIpcHandle.mock.calls[0]?.[1] as () => string
    expect(dbPathHandler()).toBe('/tmp/mailagent/sync_store.db')
  })
})
