// L4 群聊 UX 批 — 群聊成员回复 → 通知中心投影（notification_fanout.ts::maybeNotifyGroupReply）。
//
// 判据三条（assistant 行 / config.notify !== false / 群不在前台）+ dedupe 键按链合并 +
// 深链是新型 {type:'group'}（session 型会落到主 agent 会话面）。harness 照
// notification_fanout.test.ts：mock electron + fetch，断言 publish 的 snake_case body。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn(), getVersion: vi.fn(() => '1.2.3') },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  Notification: class {
    static isSupported = (): boolean => false
  }
}))

import { maybeNotifyGroupReply } from '../../src/electron/main/notification_fanout'

const API_PORT = 'MAILAGENT_API_PORT'
const savedApiPort = process.env[API_PORT]
const PUBLISH_URL = 'http://127.0.0.1:8317/api/notifications/publish'

function publishBodies(): Array<Record<string, unknown>> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => url === PUBLISH_URL)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
}

const reply = (overrides: Partial<Parameters<typeof maybeNotifyGroupReply>[0]> = {}) => ({
  sessionId: 5,
  role: 'assistant',
  content: '  调研进展如下：一二三  ',
  speakerAgentId: 'a1',
  chainId: 11,
  ...overrides
})

const getSession = vi.fn()
const notForeground = (): boolean => false
const titleOf = vi.fn(async (id: string) => (id === 'a1' ? '调研员' : null))

beforeEach(() => {
  getSession.mockReset().mockReturnValue({ title: '策划群', origin: 'group' })
  titleOf.mockClear()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  process.env[API_PORT] = '8317'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedApiPort == null) delete process.env[API_PORT]
  else process.env[API_PORT] = savedApiPort
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('maybeNotifyGroupReply', () => {
  test('N1 assistant 行 + notify 缺省 + 不在前台 → publish；dedupeKey=group_chain:{s}:{c}，body=成员名：前 80 字', async () => {
    maybeNotifyGroupReply(reply(), getSession, notForeground, titleOf)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0]).toEqual({
      category: 'results',
      source: 'group_chat',
      severity: 'info',
      title: '策划群',
      body: '调研员：调研进展如下：一二三',
      dedupe_key: 'group_chain:5:11',
      payload: { link: { type: 'group', sessionId: 5 } }
    })
    expect(titleOf).toHaveBeenCalledWith('a1')
  })

  test('N1b 正文截 80 字；标题读不到回落 agent id；群名空回落「群聊」', async () => {
    getSession.mockReturnValue({ title: '  ', origin: 'group' })
    const long = 'x'.repeat(200)
    maybeNotifyGroupReply(
      reply({ content: long, speakerAgentId: 'zz' }),
      getSession,
      notForeground,
      titleOf
    )
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0]).toMatchObject({ title: '群聊', body: `zz：${'x'.repeat(80)}` })
  })

  test('N2 config.notify=false → 不发', async () => {
    getSession.mockReturnValue({
      title: '策划群',
      origin: 'group',
      group_config_json: JSON.stringify({ v: 1, notify: false })
    })
    maybeNotifyGroupReply(reply(), getSession, notForeground, titleOf)
    await flush()
    expect(fetch).not.toHaveBeenCalled()
    // notify 缺键 / 坏 JSON = 开。
    getSession.mockReturnValue({ title: '策划群', group_config_json: '{"v":1}' })
    maybeNotifyGroupReply(reply(), getSession, notForeground, titleOf)
    getSession.mockReturnValue({ title: '策划群', group_config_json: '{not json' })
    maybeNotifyGroupReply(reply(), getSession, notForeground, titleOf)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(2))
  })

  test('N3 群在前台 → 不发', async () => {
    maybeNotifyGroupReply(reply(), getSession, () => true, titleOf)
    await flush()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('N4 user / system 行 → 不发', async () => {
    maybeNotifyGroupReply(reply({ role: 'user', speakerAgentId: null }), getSession, notForeground)
    maybeNotifyGroupReply(
      reply({ role: 'system', speakerAgentId: null, content: 'chain_cap' }),
      getSession,
      notForeground
    )
    await flush()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('N5 chainId null（v1 路径）→ dedupe 退化为 group_chain:{s}:null', async () => {
    maybeNotifyGroupReply(reply({ chainId: null }), getSession, notForeground, titleOf)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0].dedupe_key).toBe('group_chain:5:null')
  })

  test('N6 payload.link 恒为 {type:group, sessionId}（不是 session 型）', async () => {
    maybeNotifyGroupReply(reply({ sessionId: 42, chainId: 3 }), getSession, notForeground)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0].payload).toEqual({ link: { type: 'group', sessionId: 42 } })
  })

  test('N7 标题解析抛错 → 回落 id 照发；session getter 抛错 → 吞掉不 throw', async () => {
    maybeNotifyGroupReply(reply(), getSession, notForeground, () => {
      throw new Error('serve-api down')
    })
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0].body).toBe('a1：调研进展如下：一二三')
    getSession.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(() => maybeNotifyGroupReply(reply(), getSession, notForeground)).not.toThrow()
  })
})
