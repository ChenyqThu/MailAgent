// task 08-27 P4c — `today:get` IPC 的 wire 契约。
//
// 🔴 钉的是**两条载体的 path/query 严格 mirror**：Electron 走 `today:get` → daemon_api
// 转发本机 serve-api，远程 web 走 `HttpApi.today.get` 直连同一个端点。两边漂开的表现是
// 「桌面能看远程看不到」（或反过来），没有任何类型错误会拦住它 —— 这一条与
// `calendar:agenda` 的注释是同一条纪律。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const { handleMock, daemonReadMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  daemonReadMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRead: daemonReadMock }))

import { registerTodayHandlers } from '../../src/electron/main/handlers/today'

type Handler = (evt: unknown, ...args: unknown[]) => Promise<unknown>

function captureHandler(): Handler {
  handleMock.mockClear()
  registerTodayHandlers()
  const entry = handleMock.mock.calls.find((call) => call[0] === 'today:get')
  expect(entry, '没有注册 today:get 通道').toBeTruthy()
  return entry?.[1] as Handler
}

beforeEach(() => {
  daemonReadMock.mockReset()
  daemonReadMock.mockResolvedValue({ reply: [], nextHardPoint: null })
})

describe('today:get', () => {
  test('转发到 /today，query 与 HttpApi.today.get 同名同形', async () => {
    const handler = captureHandler()
    await handler(null, { tz: 'Asia/Shanghai', replyLimit: 5 })
    expect(daemonReadMock).toHaveBeenCalledWith('/today', {
      query: { tz: 'Asia/Shanghai', replyLimit: 5 }
    })
  })

  test('不带参也能调（服务端有默认 tz 与上限）', async () => {
    const handler = captureHandler()
    await handler(null)
    expect(daemonReadMock).toHaveBeenCalledWith('/today', {
      query: { tz: undefined, replyLimit: undefined }
    })
  })

  test('serve-api 不可达时原样抛，不吞成空数据', async () => {
    // 吞掉会让今日页安静地少一节（「今天没有待回的信」），比报错更糟。
    daemonReadMock.mockRejectedValue(Object.assign(new Error('down'), { code: 'E_NETWORK' }))
    const handler = captureHandler()
    await expect(handler(null, {})).rejects.toThrow('down')
  })
})
