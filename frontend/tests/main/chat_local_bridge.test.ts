// V2.1 阶段 3c (3c-1) — chat_local_bridge：main 进程 webRequest 拦截 loopback serve-api,
// 透明注入本地 token（请求腿）+ CORS 响应头（响应腿，仅打包态）。
//
// mock electron session.defaultSession.webRequest（捕获 listener，手动喂 details + 断言
// callback 参数）+ @electron-toolkit/utils is.dev（切打包/dev）+ local_token（固定 token）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  isDev: false,
  onBeforeSend: vi.fn(),
  onHeadersRecv: vi.fn()
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: h.onBeforeSend,
        onHeadersReceived: h.onHeadersRecv
      }
    }
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    get dev(): boolean {
      return h.isDev
    }
  }
}))

vi.mock('../../src/electron/main/local_token', () => ({
  getLocalApiToken: () => 'tok-xyz',
  LOCAL_TOKEN_HEADER: 'X-MailAgent-Local-Token'
}))

import { registerChatLocalBridge } from '../../src/electron/main/chat_local_bridge'

type Listener = (
  details: Record<string, unknown>,
  cb: (resp: Record<string, unknown>) => void
) => void

beforeEach(() => {
  h.isDev = false
  h.onBeforeSend.mockReset()
  h.onHeadersRecv.mockReset()
  delete process.env.MAILAGENT_API_PORT
})

afterEach(() => {
  delete process.env.MAILAGENT_API_PORT
})

describe('chat_local_bridge — 请求腿（token 注入）', () => {
  test('onBeforeSendHeaders filter 命中 loopback 8200 + 注入本地 token', () => {
    registerChatLocalBridge()
    const [filter, listener] = h.onBeforeSend.mock.calls[0] as [{ urls: string[] }, Listener]
    expect(filter.urls).toContain('http://127.0.0.1:8200/*')
    expect(filter.urls).toContain('http://localhost:8200/*')

    const cb = vi.fn()
    listener({ requestHeaders: { Accept: 'application/json' } }, cb)
    expect(cb).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'application/json', 'X-MailAgent-Local-Token': 'tok-xyz' }
    })
  })

  test('token 腿 dev/打包都注册（dev serve-api 没配 token 时该头被忽略，无害）', () => {
    h.isDev = true
    registerChatLocalBridge()
    expect(h.onBeforeSend).toHaveBeenCalledTimes(1)
  })

  test('MAILAGENT_API_PORT 覆盖 filter 端口', () => {
    process.env.MAILAGENT_API_PORT = '9300'
    registerChatLocalBridge()
    const [filter] = h.onBeforeSend.mock.calls[0] as [{ urls: string[] }]
    expect(filter.urls).toContain('http://127.0.0.1:9300/*')
  })

  test('非法 MAILAGENT_API_PORT fallback 8200', () => {
    process.env.MAILAGENT_API_PORT = 'not-a-number'
    registerChatLocalBridge()
    const [filter] = h.onBeforeSend.mock.calls[0] as [{ urls: string[] }]
    expect(filter.urls).toContain('http://127.0.0.1:8200/*')
  })
})

describe('chat_local_bridge — 响应腿（CORS 注入，仅打包态）', () => {
  test('dev 态不注册 onHeadersReceived（走 serve-api _DEV_CORS）', () => {
    h.isDev = true
    registerChatLocalBridge()
    expect(h.onHeadersRecv).not.toHaveBeenCalled()
  })

  test('打包态注入 ACAO=null + ACAC + ACAM + ACAH（credentials:include 不能用 *）', () => {
    registerChatLocalBridge()
    const [, listener] = h.onHeadersRecv.mock.calls[0] as [unknown, Listener]
    const cb = vi.fn()
    listener(
      {
        method: 'POST',
        statusCode: 200,
        responseHeaders: { 'content-type': ['application/json'] }
      },
      cb
    )
    const resp = cb.mock.calls[0][0] as {
      responseHeaders: Record<string, string[]>
      statusLine?: string
    }
    expect(resp.responseHeaders['Access-Control-Allow-Origin']).toEqual(['null'])
    expect(resp.responseHeaders['Access-Control-Allow-Credentials']).toEqual(['true'])
    expect(resp.responseHeaders['Access-Control-Allow-Methods']).toEqual([
      'GET, POST, PATCH, DELETE, OPTIONS'
    ])
    expect(resp.responseHeaders['Access-Control-Allow-Headers']).toEqual([
      'Content-Type',
      'X-MailAgent-Local-Token'
    ])
    // 保留原响应头
    expect(resp.responseHeaders['content-type']).toEqual(['application/json'])
    // 非 preflight 不改状态行
    expect(resp.statusLine).toBeUndefined()
  })

  test('OPTIONS preflight 400「Disallowed CORS origin」→ 改 statusLine 200', () => {
    registerChatLocalBridge()
    const [, listener] = h.onHeadersRecv.mock.calls[0] as [unknown, Listener]
    const cb = vi.fn()
    listener({ method: 'OPTIONS', statusCode: 400, responseHeaders: {} }, cb)
    const resp = cb.mock.calls[0][0] as {
      responseHeaders: Record<string, string[]>
      statusLine?: string
    }
    expect(resp.statusLine).toBe('HTTP/1.1 200 OK')
    expect(resp.responseHeaders['Access-Control-Allow-Origin']).toEqual(['null'])
  })

  test('GET 200 正常响应不改状态行', () => {
    registerChatLocalBridge()
    const [, listener] = h.onHeadersRecv.mock.calls[0] as [unknown, Listener]
    const cb = vi.fn()
    listener({ method: 'GET', statusCode: 200, responseHeaders: {} }, cb)
    expect((cb.mock.calls[0][0] as { statusLine?: string }).statusLine).toBeUndefined()
  })

  test('去重 serve-api 已回的 access-control-*（不分大小写）后单一来源重设', () => {
    registerChatLocalBridge()
    const [, listener] = h.onHeadersRecv.mock.calls[0] as [unknown, Listener]
    const cb = vi.fn()
    listener(
      {
        method: 'GET',
        statusCode: 200,
        responseHeaders: {
          'access-control-allow-origin': ['https://stale.example'],
          'Access-Control-Allow-Methods': ['GET']
        }
      },
      cb
    )
    const headers = (cb.mock.calls[0][0] as { responseHeaders: Record<string, string[]> })
      .responseHeaders
    // 旧的小写 ACAO 被删，不残留
    expect(headers['access-control-allow-origin']).toBeUndefined()
    expect(headers['Access-Control-Allow-Origin']).toEqual(['null'])
    expect(headers['Access-Control-Allow-Methods']).toEqual(['GET, POST, PATCH, DELETE, OPTIONS'])
  })
})
