// folder handler 的传输端契约。
//
// 🔴 两个读 (discover / whitelist) 走 `daemonRead` —— 它比 `daemonRequest` 多的唯一
// 一件事就是 E_NETWORK 重试一次, 正好盖住 serve-api 冷启 / 重启的几百毫秒窗口。
// 侧边栏文件夹树在开窗那一瞬就发 whitelist, 首拉打空则整段树不渲染 (回归: 冷启后
// 自定义文件夹整段消失)。写路径**不**改: 重试一个已经落地的写是另一种 bug。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRead, mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRead: vi.fn(),
  mockDaemonRequest: vi.fn()
}))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRead: mockDaemonRead,
  daemonRequest: mockDaemonRequest
}))

import {
  runFolderCleanup,
  runFolderDiscover,
  runFolderGetWhitelist,
  runFolderSetWhitelist
} from '../../src/electron/main/handlers/folder'

beforeEach(() => {
  mockDaemonRead.mockReset()
  mockDaemonRead.mockResolvedValue({})
  mockDaemonRequest.mockReset()
  mockDaemonRequest.mockResolvedValue({})
})

describe('folder handler — 读走 daemonRead (冷启窗口重试一次)', () => {
  test('runFolderGetWhitelist 打 GET /folder/whitelist, 不走无重试的 daemonRequest', async () => {
    await runFolderGetWhitelist()
    expect(mockDaemonRead).toHaveBeenCalledWith('/folder/whitelist')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  test('runFolderDiscover 透传 counts/refresh, 同样走 daemonRead', async () => {
    await runFolderDiscover(true, true)
    expect(mockDaemonRead).toHaveBeenCalledWith('/folder/discover', {
      query: { counts: true, refresh: true }
    })
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })
})

describe('folder handler — 写仍走 daemonRequest (不重试)', () => {
  test('runFolderSetWhitelist → PUT /folder/whitelist', async () => {
    await runFolderSetWhitelist(['Jira'])
    expect(mockDaemonRequest).toHaveBeenCalledWith('PUT', '/folder/whitelist', {
      body: { folders: ['Jira'] }
    })
    expect(mockDaemonRead).not.toHaveBeenCalled()
  })

  test('runFolderCleanup → POST /folder/cleanup', async () => {
    await runFolderCleanup('Jira')
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/folder/cleanup', {
      body: { imap_name: 'Jira' }
    })
    expect(mockDaemonRead).not.toHaveBeenCalled()
  })
})
