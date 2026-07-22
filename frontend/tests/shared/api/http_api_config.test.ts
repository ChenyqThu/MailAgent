// @vitest-environment node
//
// task 06-08-chat 第二波 — 远程 config P0+P1：HttpApi 只读配置端点 mock-fetch 单测。
//
// 覆盖 6 个去 notImplemented 的读方法 → 正确的 serve-api 路径 + 解包 envelope 返回形状：
//   settings.secretsStatus / settings.get / notionAgent.getConfig /
//   notionAgent.listModels / notionAgent.listAgents / prompts.read
// + 确认写方法（setSecret/set/setAgent/setModel/prompts.write/...）仍 reject notImplemented。
//
// fetch 全 mock：envelope 端点用真 Response（http_client.request 调 .text() 解析）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HttpApi } from '@shared/api/HttpApi'

let fetchMock: ReturnType<typeof vi.fn>
let origFetch: typeof globalThis.fetch

/** 成功 envelope 真 Response（http_client.request 解析 {status,data}）。 */
function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

/** fetch 调用 URL（第一个参数）。 */
function calledUrl(): string {
  return String(fetchMock.mock.calls[0][0])
}

/** fetch 调用 method。 */
function calledMethod(): string {
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
  return String(init?.method ?? 'GET')
}

describe('HttpApi — 远程 config 只读端点', () => {
  const api = new HttpApi('/api')

  test('settings.secretsStatus → GET /settings/secrets-status，解包 SecretsStatus', async () => {
    const status = {
      cliApiKey: true,
      llmApiKey: false,
      llmTranslateApiKey: true,
      customApiKey: false
    }
    fetchMock.mockResolvedValue(envelopeResponse(status))
    const out = await api.settings.secretsStatus()
    expect(calledMethod()).toBe('GET')
    expect(calledUrl()).toContain('/api/settings/secrets-status')
    expect(out).toEqual(status)
  })

  test('settings.get → GET /settings，解包 PersistentSettings', async () => {
    const settings = {
      dbPath: null,
      attachmentDir: null,
      pollIntervalSec: 5,
      notionAgentPageId: null,
      notionAgentName: null,
      customApiEndpoint: 'https://crs.example',
      autoDownloadUpdates: true,
      userEmail: 'owner@example.com'
    }
    fetchMock.mockResolvedValue(envelopeResponse(settings))
    const out = await api.settings.get()
    expect(calledUrl()).toContain('/api/settings')
    expect(out.userEmail).toBe('owner@example.com')
    expect(out.pollIntervalSec).toBe(5)
  })

  test('notionAgent.getConfig → GET /notion-agent/config，解包 NotionAgentConfig', async () => {
    const config = {
      accountPath: '/home/u/.notionagents/notion_account.json',
      cliPath: '/usr/bin/notion-agent',
      cliFound: true,
      configured: true,
      tokenPresent: true,
      userName: 'Lucien',
      userEmail: 'lucien@example.com',
      spaceName: 'ENBU',
      spaceId: 'sp-1',
      agentName: 'Mail Agent',
      agentPageId: 'page-abc',
      agentAccessory: null,
      defaultModel: 'opus-4.8',
      timezone: 'Asia/Shanghai'
    }
    fetchMock.mockResolvedValue(envelopeResponse(config))
    const out = await api.notionAgent.getConfig()
    expect(calledUrl()).toContain('/api/notion-agent/config')
    expect(out.configured).toBe(true)
    expect(out.agentPageId).toBe('page-abc')
    expect(out.tokenPresent).toBe(true)
  })

  test('notionAgent.listModels → GET /notion-agent/models，解包 string[]', async () => {
    fetchMock.mockResolvedValue(envelopeResponse(['opus-4.8', 'sonnet-4.6']))
    const out = await api.notionAgent.listModels()
    expect(calledUrl()).toContain('/api/notion-agent/models')
    expect(out).toEqual(['opus-4.8', 'sonnet-4.6'])
  })

  test('notionAgent.listAgents → GET /notion-agent/agents，解包 NotionAgentListItem[]', async () => {
    const agents = [
      {
        agent_id: 'a1',
        name: 'Mail Agent',
        agent_page_id: 'pg1',
        description: 'desc',
        icon: '📧'
      }
    ]
    fetchMock.mockResolvedValue(envelopeResponse(agents))
    const out = await api.notionAgent.listAgents()
    expect(calledUrl()).toContain('/api/notion-agent/agents')
    expect(out).toHaveLength(1)
    expect(out[0].agent_id).toBe('a1')
  })

  test('notionAgent.listAgents → CLI 失败 error envelope → throw err.code', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          schema_version: 1,
          data: null,
          error: { code: 'E_NOTION_AGENT_NOT_INSTALLED', message: 'not found' }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(api.notionAgent.listAgents()).rejects.toMatchObject({
      code: 'E_NOTION_AGENT_NOT_INSTALLED'
    })
  })

  test('prompts.read → GET /prompts/{slot}，解包 PromptContent', async () => {
    const payload = {
      slot: 'inbox',
      path: '/root/prompts/email_inbox.md',
      exists: true,
      content: 'prompt body'
    }
    fetchMock.mockResolvedValue(envelopeResponse(payload))
    const out = await api.prompts.read('inbox')
    expect(calledUrl()).toContain('/api/prompts/inbox')
    expect(out.content).toBe('prompt body')
  })

  test('env.get → GET /env，解包 EnvSnapshot（Bug 6 — 远程 Settings 读 .env 快照）', async () => {
    const snapshot = {
      path: '/root/.env',
      exists: true,
      values: { USER_EMAIL: 'owner@example.com', NOTION_TOKEN: '***' },
      managedKeys: ['USER_EMAIL', 'NOTION_TOKEN'],
      secretKeys: ['NOTION_TOKEN']
    }
    fetchMock.mockResolvedValue(envelopeResponse(snapshot))
    const out = await api.env.get()
    expect(calledMethod()).toBe('GET')
    expect(calledUrl()).toContain('/api/env')
    expect(out.exists).toBe(true)
    expect(out.values.USER_EMAIL).toBe('owner@example.com')
    expect(out.values.NOTION_TOKEN).toBe('***')
    expect(out.secretKeys).toContain('NOTION_TOKEN')
  })
})

describe('HttpApi — 远程 config 写方法仍 notImplemented (reject, 不 fetch)', () => {
  const api = new HttpApi('/api')

  test('settings.setSecret rejects', async () => {
    await expect(api.settings.setSecret('llmApiKey', 'x')).rejects.toThrow(/not implemented/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('settings.clearSecret rejects', async () => {
    await expect(api.settings.clearSecret('llmApiKey')).rejects.toThrow(/not implemented/)
  })

  test('settings.set rejects', async () => {
    await expect(api.settings.set({ pollIntervalSec: 10 })).rejects.toThrow(/not implemented/)
  })

  test('settings.pickFolder rejects', async () => {
    await expect(api.settings.pickFolder()).rejects.toThrow(/not implemented/)
  })

  test('settings.testLlm rejects', async () => {
    await expect(api.settings.testLlm()).rejects.toThrow(/not implemented/)
  })

  test('settings.testCustomApi rejects', async () => {
    await expect(api.settings.testCustomApi()).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.doctor rejects', async () => {
    await expect(api.notionAgent.doctor()).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.setAgent rejects', async () => {
    await expect(api.notionAgent.setAgent('pg', 'name')).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.setModel rejects', async () => {
    await expect(api.notionAgent.setModel('opus-4.8')).rejects.toThrow(/not implemented/)
  })

  test('env.set rejects (远程只读，EnvField 控件 disabled)', async () => {
    await expect(api.env.set({ USER_EMAIL: 'x@y.com' })).rejects.toThrow(/not implemented/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// v1.3.0 dogfood — prompts.write 去 notImplemented（预处理抽屉分类 prompt 可编辑）：
// PUT /prompts/{slot}，成功/失败都折回 PromptWriteResult union（镜像 ElectronApi，不 throw）。
describe('HttpApi — prompts.write 真实现', () => {
  const api = new HttpApi('/api')

  test('prompts.write → PUT /prompts/{slot} + body {content}，成功折回 {ok:true, info}', async () => {
    const info = { slot: 'inbox', path: '/root/prompts/email_inbox.md', exists: true }
    fetchMock.mockResolvedValue(envelopeResponse(info))
    const out = await api.prompts.write('inbox', 'new body')
    expect(calledMethod()).toBe('PUT')
    expect(calledUrl()).toContain('/api/prompts/inbox')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ content: 'new body' })
    expect(out).toEqual({ ok: true, info })
  })

  test('prompts.write → error envelope 折回 {ok:false, code, message}（不 throw）', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          schema_version: 1,
          data: null,
          error: { code: 'E_PATH_ESCAPE', message: 'escapes data root' }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    )
    const out = await api.prompts.write('inbox', 'x')
    expect(out).toEqual({ ok: false, code: 'E_PATH_ESCAPE', message: 'escapes data root' })
  })
})

// MED-1: HttpApi.email.search 必须把 SearchOpts.mode 映射成 serve-api 的 raw 参数,
// 否则 mailApi.email.search({mode:'raw'}) 会被当 smart (DSL 解析), 丢失 raw 逃生门。
describe('HttpApi — email.search mode→raw 映射', () => {
  const api = new HttpApi('/api')

  test("mode:'raw' → query 带 raw=true", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis', mode: 'raw' })
    expect(calledUrl()).toContain('raw=true')
  })

  test("mode:'smart' → 不带 raw 参数 (默认 smart)", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis', mode: 'smart' })
    expect(calledUrl()).not.toContain('raw=')
  })

  test('未传 mode → 不带 raw 参数', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis' })
    expect(calledUrl()).not.toContain('raw=')
  })
})

// 阶段 3.1 (#11) — calendar 写方法去 notImplemented: 契约与 ElectronApi
// (calendar-write IPC → fork CLI) 1:1, body 原样 camelCase 透传给 serve-api
// (服务端逐字镜像 CLI calendar create/update/delete/rsvp/replay 语义)。
describe('HttpApi — calendar 写方法 (阶段 3.1 #11)', () => {
  const api = new HttpApi('/api')

  function calledBody(): unknown {
    const init = fetchMock.mock.calls[0][1] as RequestInit
    return JSON.parse(String(init.body))
  }

  test('eventCreate → POST /calendar/events + body 全字段透传', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ical_uid: 'uid-new' }))
    const out = await api.calendar.eventCreate({
      summary: 'Design review',
      startIso: '2026-06-01T10:00:00+08:00',
      endIso: '2026-06-01T11:00:00+08:00',
      attendees: [{ email: 'a@example.com', name: 'Alice' }],
      calendarName: 'Work',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      isAllDay: false
    })
    expect(calledMethod()).toBe('POST')
    expect(calledUrl()).toContain('/api/calendar/events')
    expect(calledBody()).toMatchObject({
      summary: 'Design review',
      startIso: '2026-06-01T10:00:00+08:00',
      attendees: [{ email: 'a@example.com', name: 'Alice' }],
      calendarName: 'Work',
      rrule: 'FREQ=WEEKLY;BYDAY=MO'
    })
    expect(out).toEqual({ ical_uid: 'uid-new' })
  })

  test('eventUpdate → PATCH /calendar/events/{uid}; icalUid 只进 URL 不进 body; 周期参数透传', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ action: 'split_series' }))
    await api.calendar.eventUpdate({
      icalUid: 'uid a/b',
      summary: 'moved',
      recurrenceId: '2026-06-08T02:00:00Z',
      splitFuture: true,
      clearAttendees: true
    })
    expect(calledMethod()).toBe('PATCH')
    // uid URL-encode (空格/斜杠不能撕裂路径段)。
    expect(calledUrl()).toContain('/api/calendar/events/uid%20a%2Fb')
    const body = calledBody() as Record<string, unknown>
    expect(body).toMatchObject({
      summary: 'moved',
      recurrenceId: '2026-06-08T02:00:00Z',
      splitFuture: true,
      clearAttendees: true
    })
    expect(body).not.toHaveProperty('icalUid')
  })

  test('eventDelete → DELETE /calendar/events/{uid}?calendarName=…', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ action: 'deleted' }))
    await api.calendar.eventDelete({ icalUid: 'uid-1', calendarName: 'Work' })
    expect(calledMethod()).toBe('DELETE')
    expect(calledUrl()).toContain('/api/calendar/events/uid-1')
    expect(calledUrl()).toContain('calendarName=Work')
  })

  test('eventRsvp → POST /calendar/events/{uid}/rsvp + response/dryRun 透传', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ response_status: 'ACCEPTED', to_email: 'boss@example.com' })
    )
    const out = await api.calendar.eventRsvp({
      icalUid: 'uid-1',
      response: 'accept',
      dryRun: true
    })
    expect(calledUrl()).toContain('/api/calendar/events/uid-1/rsvp')
    expect(calledBody()).toMatchObject({ response: 'accept', dryRun: true })
    expect(out).toMatchObject({ response_status: 'ACCEPTED' })
  })

  test('eventReplay → POST /calendar/events/{uid}/replay + source 透传', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ action: 'updated', page_id: 'pg-1' }))
    await api.calendar.eventReplay({ icalUid: 'uid-1', source: 'caldav' })
    expect(calledUrl()).toContain('/api/calendar/events/uid-1/replay')
    expect(calledBody()).toMatchObject({ source: 'caldav' })
  })

  test('eventUpdate error envelope → throw err.code (E_NOT_FOUND)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          schema_version: 1,
          data: null,
          error: { code: 'E_NOT_FOUND', message: 'event not found by UID' }
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(
      api.calendar.eventUpdate({ icalUid: 'uid-x', summary: 'y' })
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})

// #5 远程日历空 bug 回归 — serve-api 已按 C7 契约把裸数组/对象放进 envelope.data
// （total/window/filters/worker_enabled 落 meta）。HttpApi 不可再取 .events/.event/
// .calendars，否则对裸数组求属性永远 undefined → 远程日历永远空（本地 Electron 走
// IPC 直读 SQLite 不受影响，故只有远程坏）。
describe('HttpApi — calendar C7 裸数组解包（远程日历空 bug 回归）', () => {
  const api = new HttpApi('/api')

  test('eventsList → 返回裸 occurrence 数组（非 data.events）', async () => {
    const occ = [
      { ical_uid: 'u1', recurrence_id: null, summary: 'Standup' },
      { ical_uid: 'u2', recurrence_id: null, summary: 'Review' }
    ]
    fetchMock.mockResolvedValue(envelopeResponse(occ))
    const out = await api.calendar.eventsList({ fromIso: '2026-06-26', toIso: '2026-07-03' })
    expect(calledMethod()).toBe('GET')
    expect(calledUrl()).toContain('/api/calendar/events')
    expect(out).toHaveLength(2)
    expect(out).toEqual(occ)
  })

  test('eventsList 空数组 envelope → []（不抛）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse([]))
    const out = await api.calendar.eventsList()
    expect(out).toEqual([])
  })

  test('syncStatus → 返回裸 sync-state 数组（非 data.calendars）', async () => {
    const states = [{ calendar_name: 'Work', ctag: 'c1', last_synced_at: null }]
    fetchMock.mockResolvedValue(envelopeResponse(states))
    const out = await api.calendar.syncStatus()
    expect(calledUrl()).toContain('/api/calendar/sync-status')
    expect(out).toHaveLength(1)
    expect(out).toEqual(states)
  })

  test('eventGet → 返回裸 detail 对象（非 data.event）', async () => {
    const detail = { ical_uid: 'u1', recurrence_id: null, summary: 'Standup' }
    fetchMock.mockResolvedValue(envelopeResponse(detail))
    const out = await api.calendar.eventGet({ icalUid: 'u1' })
    expect(calledUrl()).toContain('/api/calendar/events/u1')
    expect(out).toEqual(detail)
  })
})
