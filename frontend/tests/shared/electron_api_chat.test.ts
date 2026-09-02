// @vitest-environment happy-dom
//
// V2.1 阶段 3 / S3 — ElectronApi.chat 接线单测。
//
// S3 删 legacy 引擎后 ElectronApi.chat = shared/api/chat_api.ts 的直 fetch 面
// （serve-api 薄传输）。本测验 electron 特有的「壳」三点：
//   - loopback baseUrl 端口来源：main 经 `?apiPort=N` 注入 window.location.search，
//     缺省 / 非法回退 8200（renderer 进程无 process.env，端口必由 main 透传）。
//   - openPopout override：shared runtime 里是 no-op → electron 回 main 的
//     window:openChatPopout IPC（guard 非法 id）。
//   - chat 字段是存活 ChatApi 直 fetch 面（引擎面方法已随 legacy 删除）。
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

describe('ElectronApi.chat — listAllSessions 的 query 拼装（L4 批次3）', () => {
  test('itemId 上 wire，且**不**补 origin —— 缺省的单源在服务端', async () => {
    const api = new ElectronApi()
    await api.chat.listAllSessions({ itemId: 7 })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('itemId=7')
    // 🔴 前端补一个 origin=interactive 就会把行动项的 headless 执行 run 全过滤掉
    //（服务端对 itemId 查询的缺省是 all）。
    expect(url).not.toContain('origin=')
  })

  test('显式 origin 照旧上 wire（缺省只在没传时生效）', async () => {
    const api = new ElectronApi()
    await api.chat.listAllSessions({ itemId: 7, origin: 'interactive' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('origin=interactive')
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

describe('ElectronApi.chat — S3 直 fetch ChatApi 形状', () => {
  test('chat 暴露全部存活 ChatApi 方法（引擎面 start/onStream/confirmTool 已随 legacy 删）', () => {
    const api = new ElectronApi()
    const methods = [
      'newSession',
      'saveToKos',
      'deleteSession',
      'updateSessionTitle',
      'updateSessionArchived',
      'updateSessionPinned',
      'updateSessionStarred',
      'openPopout',
      'listMessages',
      'listSessions',
      'getSession',
      'listAllSessions',
      'listGeneralSessions',
      'listToolCalls',
      'kosAvailable',
      'listSkills',
      'setSkillEnabled',
      'listPolicyRules',
      'compileUserMd',
      'listProfileDocs',
      'fetchSkillPack',
      'confirmSkillPack',
      'uninstallSkillPack'
    ]
    for (const m of methods) {
      expect(typeof (api.chat as unknown as Record<string, unknown>)[m]).toBe('function')
    }
    // 引擎面已删（S3 D1/D5）：不再存在这些方法。
    for (const gone of [
      'start',
      'editMessage',
      'abort',
      'confirmTool',
      'onStream',
      'runSearchAgent',
      'invalidateConfig'
    ]) {
      expect((api.chat as unknown as Record<string, unknown>)[gone]).toBeUndefined()
    }
  })
})

describe('ElectronApi.chat — onGroupTurn / setGroupForeground（L4 群聊 UX 批）', () => {
  test('I1 onGroupTurn 用 on() 返回的 disposer 反订阅', () => {
    const dispose = vi.fn()
    const onMock = vi.fn((_channel: string, _fn: unknown) => dispose)
    ;(window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { invoke: vi.fn(), send: sendMock, on: onMock }
    }
    const api = new ElectronApi()
    const off = api.chat.onGroupTurn!(() => {})
    expect(onMock).toHaveBeenCalledTimes(1)
    expect(onMock.mock.calls[0]![0]).toBe('chat:group-turn')
    expect(dispose).not.toHaveBeenCalled()
    off()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('I2 形状不符事件不触发 handler；合法事件窄化后到达', () => {
    let listener: ((...args: unknown[]) => void) | null = null
    const onMock = vi.fn((_channel: string, fn: (...args: unknown[]) => void) => {
      listener = fn
      return () => undefined
    })
    ;(window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { invoke: vi.fn(), send: sendMock, on: onMock }
    }
    const api = new ElectronApi()
    const handler = vi.fn()
    api.chat.onGroupTurn!(handler)
    expect(listener).not.toBeNull()
    const emit = (payload: unknown): void => listener!({}, payload)
    emit({ v: 1, sessionId: 7, phase: 'typing' })
    emit({ v: 2 })
    emit(null)
    expect(handler).not.toHaveBeenCalled()
    const valid = {
      v: 1,
      sessionId: 7,
      runId: 'r',
      chainId: 1,
      seq: 1,
      agentId: 'a',
      phase: 'delta',
      ts: 5,
      queued: [],
      chainProgress: { counted: 0, cap: 12 },
      text: '正在写',
      messageId: 'not-a-number'
    }
    emit(valid)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toEqual({ ...valid, messageId: undefined })
    expect('messageId' in handler.mock.calls[0]![0]).toBe(false)
  })

  test('I3 setGroupForeground → invoke chat:group-foreground {sessionId}', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { invoke, send: sendMock, on: vi.fn(() => () => undefined) }
    }
    const api = new ElectronApi()
    await api.chat.setGroupForeground!(9)
    await api.chat.setGroupForeground!(null)
    expect(invoke.mock.calls).toEqual([
      ['chat:group-foreground', { sessionId: 9 }],
      ['chat:group-foreground', { sessionId: null }]
    ])
  })
})
