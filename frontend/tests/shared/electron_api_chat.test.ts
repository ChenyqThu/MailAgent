// @vitest-environment happy-dom
//
// V2.1 阶段 3 — 3c-3：ElectronApi.chat cutover 接线单测。
//
// 3c-3 把 ElectronApi.chat 从 IPC 封装（旧 ElectronChatApi）切到进程内 ChatRuntime
// （createChatRuntime + HttpChatPlatform fetch loopback serve-api）。chat 引擎本身由
// tests/shared/chat/runtime.test.ts 钉；本测只验 electron 特有的「壳」三点：
//   - loopback baseUrl 端口来源：main 经 `?apiPort=N` 注入 window.location.search，
//     缺省 / 非法回退 8200（renderer 进程无 process.env，端口必由 main 透传）。
//   - openPopout override：shared runtime 里是 no-op → electron 回 main 的
//     window:openChatPopout IPC（guard 非法 id，对齐旧 ElectronChatApi）。
//   - chat 字段是完整 ChatApi（createElectronChatRuntime 产物）。
//
// fetch 全 mock（只断言 URL = baseUrl 端口生效，不验 runtime 内部语义）；
// window.electron.ipcRenderer stub。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ElectronApi } from '../../src/shared/api/ElectronApi'

function setSearch(search: string): void {
  // happy-dom：mirror main-process 的 URL hand-off（同 popout-mode.test.ts）。
  window.history.replaceState({}, '', `${window.location.pathname}${search}`)
}

/** 成功 envelope 真 Response（http_client.request 调 .text() 解析）。 */
function env(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

let fetchMock: ReturnType<typeof vi.fn>
let sendMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setSearch('')
  fetchMock = vi.fn(async () => env([]))
  vi.stubGlobal('fetch', fetchMock)
  sendMock = vi.fn()
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: vi.fn(), send: sendMock, on: vi.fn(() => () => undefined) }
  }
})

afterEach(() => {
  setSearch('')
  vi.unstubAllGlobals()
  delete (window as unknown as { electron?: unknown }).electron
})

describe('ElectronApi.chat — 3c-3 loopback baseUrl 端口注入', () => {
  test('?apiPort=9300 → chat 读打 127.0.0.1:9300/api', async () => {
    setSearch('?apiPort=9300')
    const api = new ElectronApi()
    await api.chat.listMessages(5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://127.0.0.1:9300/api/chat/sessions/5/messages'
    )
  })

  test('无 apiPort → 回退 8200', async () => {
    setSearch('')
    const api = new ElectronApi()
    await api.chat.listSessions(7)
    expect(String(fetchMock.mock.calls[0][0])).toContain('http://127.0.0.1:8200/api/chat/sessions')
  })

  test('apiPort 非数字 → 回退 8200', async () => {
    setSearch('?apiPort=not-a-number')
    const api = new ElectronApi()
    await api.chat.listAllSessions()
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'http://127.0.0.1:8200/api/chat/sessions/all'
    )
  })

  test('apiPort<=0 → 回退 8200', async () => {
    setSearch('?apiPort=0')
    const api = new ElectronApi()
    await api.chat.listAllSessions()
    expect(String(fetchMock.mock.calls[0][0])).toContain('127.0.0.1:8200')
  })
})

describe('ElectronApi.chat — 3c-3 openPopout override', () => {
  test('openPopout(id) → window:openChatPopout IPC（shared runtime no-op 被 override）', () => {
    const api = new ElectronApi()
    api.chat.openPopout(42)
    expect(sendMock).toHaveBeenCalledWith('window:openChatPopout', 42)
  })

  test('openPopout 非法 id → 不发 IPC（guard 对齐旧 ElectronChatApi）', () => {
    const api = new ElectronApi()
    api.chat.openPopout(-1)
    api.chat.openPopout(1.5)
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('ElectronApi.chat — 3c-3 完整 ChatApi 形状', () => {
  test('chat 暴露全部 ChatApi 方法（createElectronChatRuntime 产物，非旧 IPC 封装）', () => {
    const api = new ElectronApi()
    const methods = [
      'start',
      'editMessage',
      'abort',
      'confirmTool',
      'newSession',
      'saveToKos',
      'deleteSession',
      'openPopout',
      'listMessages',
      'listSessions',
      'listAllSessions',
      'listToolCalls',
      'kosAvailable',
      'onStream'
    ]
    for (const m of methods) {
      expect(typeof (api.chat as unknown as Record<string, unknown>)[m]).toBe('function')
    }
  })
})
