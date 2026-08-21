// task 08-20 — Notion OAuth attempt 状态机 + loopback 回调 + 库发现（Lane 2）。
//
// loopback 用真实 http server（不 mock net 层），回调经真实 fetch 打进来；
// electron / env 写入 / exchange 网络面经 __test__.setDeps 注入。
// 覆盖 prd 验收 3c/3d/4：错 state 不消耗 attempt、code 只消费一次、重复 start
// 原子替换、超时/取消清理、固定页零回显 + 安全响应头、token 不进任何 IPC 载荷。
// 🔴 新断言均做过变异验证（把被测逻辑临时改坏确认变红再还原，见任务执行记录）。

import { createServer, type Server } from 'http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  __test__,
  CALLBACK_PATH,
  discoverFromSearch,
  discoverFromTemplate,
  ERROR_HTML,
  FAILURE_HTML,
  listDatabases,
  removeConnection,
  selectDatabases,
  startNotionOauth,
  cancelNotionOauth,
  SUCCESS_HTML,
  type NotionOauthStatusEvent
} from '../../src/electron/main/notion_oauth'
import { requiredProperties } from '../../src/shared/lib/notionDbSchema'
import { MANAGED_ENV_KEY_SET } from '../../src/electron/main/lib/env-keys'

// ---- 共享 fake 环境 -------------------------------------------------------

const TOKEN = 'secret_test_token_abc123'
const CODE = 'test-authorization-code-1'

let events: NotionOauthStatusEvent[] = []
let patches: Array<Record<string, string | null>> = []
let opened: string[] = []

function baseDeps(overrides: Record<string, unknown> = {}): void {
  __test__.setDeps({
    openExternal: async (url: string) => {
      opened.push(url)
    },
    broadcast: (_ch, payload) => {
      events.push(payload)
    },
    writeEnvPatch: (patch) => {
      patches.push(patch)
      return { ok: true, path: '/tmp/.env', changedKeys: Object.keys(patch), restartRequired: true }
    },
    fetchImpl: (async () => {
      throw new Error('unexpected fetch (test did not route this)')
    }) as typeof fetch,
    ...overrides
  })
}

beforeEach(() => {
  __test__.reset()
  events = []
  patches = []
  opened = []
  baseDeps()
})

afterEach(() => {
  __test__.reset()
})

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error(`waitUntil timeout; events=${JSON.stringify(events)}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

function phaseSeen(phase: string): boolean {
  return events.some((e) => e.phase === phase)
}

/** patch 里任何一个键不在 MANAGED_ENV_KEYS 白名单，writePatch 会**整体**拒收
 *  (E_INVALID_KEY) —— 即「加了键忘了登记白名单」= 整个授权流写不进配置。 */
function expectAllKeysManaged(patch: Record<string, string | null>): void {
  const unmanaged = Object.keys(patch).filter((k) => !MANAGED_ENV_KEY_SET.has(k))
  expect(unmanaged, 'patch 含未登记 MANAGED_ENV_KEYS 的键 → writePatch 整体拒收').toEqual([])
}

/** 当前活跃 attempt 的实际端口（不硬编码 9280 —— 上个用例刚释放的 socket 偶发未及回收时
 *  会落 9281，硬编码端口会把时序抖动误报成状态机 bug）。 */
function activePort(): number {
  const port = __test__.snapshot().port
  if (port == null) throw new Error('no active attempt')
  return port
}

async function callback(port: number, params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString()
  return fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?${qs}`)
}

async function occupy(host: string, port: number): Promise<Server> {
  const srv = createServer(() => {})
  await new Promise<void>((resolve, reject) => {
    srv.on('error', reject)
    srv.listen(port, host, resolve)
  })
  return srv
}

// ---- fixture 路由（真实 2025-09-03 响应形态） ------------------------------

type Route = {
  match: (u: URL, init?: RequestInit) => boolean
  reply: (u: URL, init?: RequestInit) => { status?: number; json: unknown }
}

function routedFetch(routes: Route[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input))
    for (const r of routes) {
      if (r.match(u, init)) {
        const { status = 200, json } = r.reply(u, init)
        return new Response(JSON.stringify(json), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
    throw new Error(`unrouted fetch: ${u.pathname}`)
  }) as typeof fetch
}

function propsFor(role: 'email' | 'calendar'): Record<string, { type: string }> {
  const out: Record<string, { type: string }> = {}
  for (const p of requiredProperties(role)) out[p.name] = { type: p.type }
  return out
}

const exchangeRoute = (dto: Record<string, unknown>, status = 200): Route => ({
  match: (u) => u.pathname === '/api/oauth/notion/exchange',
  reply: () => ({ status, json: dto })
})

/** 模板路径全套 fixture —— 按 owner 真实模板「Daily Dashboard Template」结构造
 *  （design.md 实勘约束）：顶层 = linked view（child_database 块形态但 GET database
 *  404）+「数据库 & 文档」toggle + child_page；真库（email / calendar / Daily
 *  Digests 三个）嵌在 toggle 内部。 */
function templateRoutes(): Route[] {
  return [
    exchangeRoute({
      access_token: TOKEN,
      workspace_id: 'ws-1',
      workspace_name: 'Acme Workspace',
      duplicated_template_id: 'tpl-1',
      bot_id: 'should-be-ignored'
    }),
    {
      match: (u) =>
        u.pathname === '/v1/blocks/tpl-1/children' && !u.searchParams.has('start_cursor'),
      reply: () => ({
        json: {
          object: 'list',
          results: [
            // linked view：child_database 块形态，但对 block.id GET database 会 404。
            {
              object: 'block',
              id: 'lv-1',
              type: 'child_database',
              child_database: { title: 'Linked View A' }
            },
            {
              object: 'block',
              id: 'tg-1',
              type: 'toggle',
              has_children: true,
              toggle: { rich_text: [{ plain_text: '数据库 & 文档' }] }
            },
            // child_page：不下钻（没有对应 children 路由，误下钻会 unrouted 抛错）。
            {
              object: 'block',
              id: 'cp-1',
              type: 'child_page',
              has_children: true,
              child_page: { title: 'Docs' }
            },
            { object: 'block', id: 'blk-p', type: 'paragraph', paragraph: { rich_text: [] } }
          ],
          has_more: true,
          next_cursor: 'cur-2'
        }
      })
    },
    {
      match: (u) =>
        u.pathname === '/v1/blocks/tpl-1/children' &&
        u.searchParams.get('start_cursor') === 'cur-2',
      reply: () => ({
        json: {
          object: 'list',
          results: [
            {
              object: 'block',
              id: 'lv-2',
              type: 'child_database',
              child_database: { title: 'Linked View B' }
            }
          ],
          has_more: false,
          next_cursor: null
        }
      })
    },
    {
      // toggle 内部：三个真库。
      match: (u) => u.pathname === '/v1/blocks/tg-1/children',
      reply: () => ({
        json: {
          object: 'list',
          results: [
            {
              object: 'block',
              id: 'db-email',
              type: 'child_database',
              child_database: { title: 'Email Inbox' }
            },
            {
              object: 'block',
              id: 'db-cal',
              type: 'child_database',
              child_database: { title: 'Calendar' }
            },
            {
              object: 'block',
              id: 'db-digest',
              type: 'child_database',
              child_database: { title: 'Daily Digests' }
            }
          ],
          has_more: false,
          next_cursor: null
        }
      })
    },
    // linked view 判据：GET /v1/databases/{block.id} 404。
    {
      match: (u) => u.pathname === '/v1/databases/lv-1' || u.pathname === '/v1/databases/lv-2',
      reply: () => ({
        status: 404,
        json: {
          object: 'error',
          status: 404,
          code: 'object_not_found',
          message: 'Could not find database'
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/databases/db-digest',
      reply: () => ({
        json: {
          object: 'database',
          id: 'db-digest',
          title: [{ type: 'text', plain_text: 'Daily Digests' }],
          data_sources: [{ id: 'ds-digest', name: 'Daily Digests' }]
        }
      })
    },
    {
      // 第三真库：两个签名都不命中 → unknown，自然落选。
      match: (u) => u.pathname === '/v1/data_sources/ds-digest',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-digest',
          parent: { type: 'database_id', database_id: 'db-digest' },
          title: [{ plain_text: 'Daily Digests' }],
          properties: { Name: { type: 'title' }, Date: { type: 'date' } }
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/databases/db-email',
      reply: () => ({
        json: {
          object: 'database',
          id: 'db-email',
          title: [{ type: 'text', plain_text: 'Email Inbox' }],
          data_sources: [{ id: 'ds-email', name: 'Email Inbox' }]
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/data_sources/ds-email',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-email',
          parent: { type: 'database_id', database_id: 'db-email' },
          title: [{ plain_text: 'Email Inbox' }],
          properties: propsFor('email')
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/databases/db-cal',
      reply: () => ({
        json: {
          object: 'database',
          id: 'db-cal',
          title: [{ type: 'text', plain_text: 'Calendar' }],
          data_sources: [{ id: 'ds-cal', name: 'Calendar' }]
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/data_sources/ds-cal',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-cal',
          parent: { type: 'database_id', database_id: 'db-cal' },
          title: [{ plain_text: 'Calendar' }],
          properties: propsFor('calendar')
        }
      })
    }
  ]
}

/** 已有页面（search）fixture：两个 email data_source（inline properties 形态）+
 *  一个 database 形态展开的 calendar；ds-e2 重取时缺字段（验证 main 重校验不信缓存）。 */
function searchRoutes(): Route[] {
  const missingEmail = propsFor('email')
  delete (missingEmail as Record<string, unknown>)['Message ID']
  return [
    exchangeRoute({
      access_token: TOKEN,
      workspace_id: 'ws-1',
      workspace_name: 'Acme Workspace',
      duplicated_template_id: null
    }),
    {
      match: (u) => u.pathname === '/v1/search',
      reply: () => ({
        json: {
          object: 'list',
          results: [
            {
              object: 'data_source',
              id: 'ds-e1',
              parent: { type: 'database_id', database_id: 'db-e1' },
              title: [{ plain_text: 'Mail A' }],
              properties: propsFor('email')
            },
            {
              object: 'data_source',
              id: 'ds-e2',
              parent: { type: 'database_id', database_id: 'db-e2' },
              title: [{ plain_text: 'Mail B' }],
              properties: propsFor('email')
            },
            { object: 'database', id: 'db-c' }
          ],
          has_more: false,
          next_cursor: null
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/databases/db-c',
      reply: () => ({
        json: {
          object: 'database',
          id: 'db-c',
          title: [{ type: 'text', plain_text: 'Cal C' }],
          data_sources: [{ id: 'ds-c', name: 'Cal C' }]
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/data_sources/ds-c',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-c',
          parent: { type: 'database_id', database_id: 'db-c' },
          title: [{ plain_text: 'Cal C' }],
          properties: propsFor('calendar')
        }
      })
    },
    {
      match: (u) => u.pathname === '/v1/data_sources/ds-e1',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-e1',
          parent: { type: 'database_id', database_id: 'db-e1' },
          properties: propsFor('email')
        }
      })
    },
    {
      // 🔴 重取时缺 Message ID —— selectDatabases 的 main 重校验必须抓住。
      match: (u) => u.pathname === '/v1/data_sources/ds-e2',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-e2',
          parent: { type: 'database_id', database_id: 'db-e2' },
          properties: missingEmail
        }
      })
    }
  ]
}

// ---- 用例 -----------------------------------------------------------------

describe('start / loopback', () => {
  test('start → waiting_callback + localhost redirect + 双栈监听 + state 上 URL', async () => {
    const r = await startNotionOauth()
    expect(r.ok).toBe(true)
    const snap = __test__.snapshot()
    expect(snap.phase).toBe('waiting_callback')
    expect(snap.port).toBe(9280)
    expect(snap.serverCount).toBe(2) // 127.0.0.1 + ::1 同端口
    expect(opened).toHaveLength(1)
    const auth = new URL(opened[0])
    expect(auth.origin + auth.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(auth.searchParams.get('redirect_uri')).toBe(`http://localhost:9280${CALLBACK_PATH}`)
    expect(auth.searchParams.get('response_type')).toBe('code')
    expect(auth.searchParams.get('owner')).toBe('user')
    expect(auth.searchParams.get('state')).toBe(__test__.currentState())
    // ::1 监听真实可达（浏览器解析 localhost 可能先试 IPv6）。
    const v6 = await fetch(`http://[::1]:9280/nope`)
    expect(v6.status).toBe(404)
  })

  test('9280 被占 → 落 9281；两个都占 → port_unavailable', async () => {
    const blocker = await occupy('127.0.0.1', 9280)
    try {
      const r = await startNotionOauth()
      expect(r.ok).toBe(true)
      expect(__test__.snapshot().port).toBe(9281)
      const auth = new URL(opened[0])
      expect(auth.searchParams.get('redirect_uri')).toBe(`http://localhost:9281${CALLBACK_PATH}`)
      __test__.reset()
      baseDeps() // reset 会还原 electron 默认 deps，测试环境里必须重挂 fake
      const blocker2 = await occupy('127.0.0.1', 9281)
      try {
        const r2 = await startNotionOauth()
        expect(r2).toEqual({ ok: false, errorCode: 'port_unavailable' })
        expect(__test__.snapshot().hasActive).toBe(false)
      } finally {
        blocker2.close()
      }
    } finally {
      blocker.close()
    }
  })

  test('仅 ::1:9280 被占 → 两栈必须同端口，整体切 9281', async () => {
    const blocker = await occupy('::1', 9280)
    try {
      const r = await startNotionOauth()
      expect(r.ok).toBe(true)
      expect(__test__.snapshot().port).toBe(9281)
      expect(__test__.snapshot().serverCount).toBe(2)
    } finally {
      blocker.close()
    }
  })
})

describe('回调防护（错 path / 非 GET / 错 state 不消耗 attempt）', () => {
  test('探测请求拿固定错误页，attempt 原样；随后正确回调仍然生效', async () => {
    baseDeps({ fetchImpl: routedFetch(templateRoutes()) })
    await startNotionOauth()
    const state = __test__.currentState()!

    const port = activePort()
    const wrongPath = await fetch(`http://127.0.0.1:${port}/whatever`)
    expect(wrongPath.status).toBe(404)
    expect(await wrongPath.text()).toBe(ERROR_HTML)

    const wrongMethod = await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.text()).toBe(ERROR_HTML)

    const marker = 'REFLECTED_MARKER_XYZ'
    const wrongState = await callback(port, { state: 'wrong-state', code: CODE, foo: marker })
    expect(wrongState.status).toBe(400)
    const body = await wrongState.text()
    expect(body).toBe(ERROR_HTML)
    expect(body).not.toContain(marker) // 零参数回显

    // 三连击后 attempt 未被消耗。
    expect(__test__.snapshot().phase).toBe('waiting_callback')
    expect(__test__.snapshot().codeConsumed).toBe(false)

    const good = await callback(port, { state, code: CODE })
    expect(good.status).toBe(200)
    expect(await good.text()).toBe(SUCCESS_HTML)
    await waitUntil(() => phaseSeen('done'))
  })

  test('固定页带安全响应头', async () => {
    await startNotionOauth()
    const resp = await fetch(`http://127.0.0.1:${activePort()}/probe`)
    expect(resp.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
    expect(resp.headers.get('referrer-policy')).toBe('no-referrer')
    expect(resp.headers.get('cache-control')).toBe('no-store')
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resp.headers.get('access-control-allow-origin')).toBeNull() // 不开 CORS
  })
})

describe('code 一次性 + 模板自动流', () => {
  test('双回调只换一次 token；done 后内存全清；token/code 不进任何广播载荷', async () => {
    let exchangeCalls = 0
    // exchange 卡在 gate 上 —— 重放回调发生在换 token 进行中（最危险的窗口）。
    let releaseExchange!: () => void
    const gate = new Promise<void>((r) => {
      releaseExchange = r
    })
    const routes = templateRoutes()
    const routed = routedFetch(routes)
    baseDeps({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/api/oauth/notion/exchange') {
          exchangeCalls++
          await gate
        }
        return (routed as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(input, init)
      }) as typeof fetch
    })
    await startNotionOauth()
    const state = __test__.currentState()!

    const port = activePort()
    const first = await callback(port, { state, code: CODE })
    expect(await first.text()).toBe(SUCCESS_HTML)
    // 双回调（重放同 code + 同 state，exchange 尚在途）→ 固定错误页，不再换 token。
    const replay = await callback(port, { state, code: CODE })
    expect(replay.status).toBe(400)
    expect(await replay.text()).toBe(ERROR_HTML)

    releaseExchange()
    await waitUntil(() => phaseSeen('done'))
    expect(exchangeCalls).toBe(1)

    // 七键原子 patch；🔴 无 NOTION_REFRESH_TOKEN。
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0]).sort()).toEqual([
      'CALENDAR_DATABASE_ID',
      'CALENDAR_DATA_SOURCE_ID',
      'EMAIL_DATABASE_ID',
      'EMAIL_DATA_SOURCE_ID',
      'NOTION_TOKEN',
      'NOTION_WORKSPACE_ID',
      'NOTION_WORKSPACE_NAME'
    ])
    expect(patches[0]['NOTION_TOKEN']).toBe(TOKEN)
    expect(patches[0]['EMAIL_DATABASE_ID']).toBe('db-email')
    expect(patches[0]['CALENDAR_DATABASE_ID']).toBe('db-cal')
    // 🔴 落盘的是**选中的 data source**，不是 database 容器 id（Python 侧没有这两个键
    // 就会盲取 data_sources[0]；多 data source 库上那是另一个数据源）。
    expect(patches[0]['EMAIL_DATA_SOURCE_ID']).toBe('ds-email')
    expect(patches[0]['CALENDAR_DATA_SOURCE_ID']).toBe('ds-cal')
    expectAllKeysManaged(patches[0])

    // done 载荷只带展示信息。
    const done = events.find((e) => e.phase === 'done')!
    expect(done.workspaceName).toBe('Acme Workspace')
    expect(done.emailDbTitle).toBe('Email Inbox')
    expect(done.calendarDbTitle).toBe('Calendar')

    // token/code 不出现在任何 IPC 广播载荷里。
    const wire = JSON.stringify(events)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain(CODE)

    // attempt 结束后内存全清。
    const snap = __test__.snapshot()
    expect(snap.hasActive).toBe(false)
    expect(snap.hasToken).toBe(false)
    expect(snap.hasState).toBe(false)
    expect(snap.candidateCount).toBeNull()
  })

  test('Notion 侧拒绝（error 参数）→ denied，失败页，配置不写', async () => {
    await startNotionOauth()
    const state = __test__.currentState()!
    const resp = await callback(activePort(), { state, error: 'access_denied' })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe(FAILURE_HTML)
    await waitUntil(() => events.some((e) => e.phase === 'error' && e.errorCode === 'denied'))
    expect(patches).toHaveLength(0)
    expect(__test__.snapshot().hasActive).toBe(false)
  })

  test('exchange 稳定错误码透传（invalid_grant）→ error，配置不写', async () => {
    baseDeps({ fetchImpl: routedFetch([exchangeRoute({ error: 'invalid_grant' }, 400)]) })
    await startNotionOauth()
    const resp = await callback(activePort(), { state: __test__.currentState()!, code: CODE })
    expect(await resp.text()).toBe(SUCCESS_HTML)
    await waitUntil(() =>
      events.some((e) => e.phase === 'error' && e.errorCode === 'invalid_grant')
    )
    expect(patches).toHaveLength(0)
  })
})

describe('重复 start / 超时 / 取消', () => {
  test('重复 start 原子替换：旧 attempt 收 cancelled，旧 state 迟到回调无效', async () => {
    baseDeps({ fetchImpl: routedFetch(templateRoutes()) })
    const a = await startNotionOauth()
    const stateA = __test__.currentState()!
    const b = await startNotionOauth()
    expect(a.ok && b.ok).toBe(true)
    const idA = a.ok ? a.attemptId : ''
    const idB = b.ok ? b.attemptId : ''
    expect(idA).not.toBe(idB)
    expect(events.some((e) => e.attemptId === idA && e.errorCode === 'cancelled')).toBe(true)
    expect(__test__.snapshot().attemptId).toBe(idB)

    // 旧 attempt 的迟到回调（旧 state）打到 B 的端口 → 固定错误页，B 不受影响。
    // （B 通常复用 9280；若 A 的 socket 尚未完全释放则落 9281 —— 用快照端口不赌时序。）
    const portB = __test__.snapshot().port!
    const late = await callback(portB, { state: stateA, code: CODE })
    expect(late.status).toBe(400)
    expect(__test__.snapshot().codeConsumed).toBe(false)
    expect(__test__.snapshot().phase).toBe('waiting_callback')
  })

  test('超时 → error timeout + server 关闭 + 内存清空', async () => {
    baseDeps({ attemptTimeoutMs: 40 })
    await startNotionOauth()
    const port = activePort()
    await waitUntil(() => events.some((e) => e.phase === 'error' && e.errorCode === 'timeout'))
    expect(__test__.snapshot().hasActive).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/probe`)).rejects.toThrow()
  })

  test('cancel → error cancelled + server 关闭', async () => {
    const r = await startNotionOauth()
    const id = r.ok ? r.attemptId : ''
    const port = activePort()
    cancelNotionOauth(id)
    expect(events.some((e) => e.attemptId === id && e.errorCode === 'cancelled')).toBe(true)
    expect(__test__.snapshot().hasActive).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/probe`)).rejects.toThrow()
  })
})

describe('need_selection / selectDatabases（main 重校验）', () => {
  async function driveToSelection(): Promise<string> {
    baseDeps({ fetchImpl: routedFetch(searchRoutes()) })
    const r = await startNotionOauth()
    const id = r.ok ? r.attemptId : ''
    await callback(activePort(), { state: __test__.currentState()!, code: CODE })
    await waitUntil(() => phaseSeen('need_selection'))
    return id
  }

  test('两个合法 email 候选 → 不盲选，进 need_selection；候选列表是非敏感投影', async () => {
    const id = await driveToSelection()
    const list = listDatabases(id)
    expect(list).toHaveLength(3)
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual([
        'id',
        'missing',
        'role',
        'title',
        'valid',
        'warnings'
      ])
    }
    expect(list.filter((c) => c.role === 'email' && c.valid)).toHaveLength(2)
    expect(list.filter((c) => c.role === 'calendar' && c.valid)).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(TOKEN)
    // 错误 attemptId → 空（renderer 传值不被信任）。
    expect(listDatabases('nope')).toEqual([])
  })

  test('selectDatabases：同 id / 列表外 id / 重取缺字段 → selection_invalid；合法对 → 写库并 done', async () => {
    const id = await driveToSelection()

    expect(await selectDatabases(id, 'ds-e1', 'ds-e1')).toEqual({
      ok: false,
      errorCode: 'selection_invalid'
    })
    expect(await selectDatabases(id, 'ds-rogue', 'ds-c')).toEqual({
      ok: false,
      errorCode: 'selection_invalid'
    })
    // ds-e2 在候选里合法，但 main 重取时缺 Message ID → 拒（不信任缓存/renderer）。
    expect(await selectDatabases(id, 'ds-e2', 'ds-c')).toEqual({
      ok: false,
      errorCode: 'selection_invalid'
    })
    expect(patches).toHaveLength(0)

    expect(await selectDatabases(id, 'ds-e1', 'ds-c')).toEqual({ ok: true })
    await waitUntil(() => phaseSeen('done'))
    expect(patches).toHaveLength(1)
    expect(patches[0]['EMAIL_DATABASE_ID']).toBe('db-e1')
    expect(patches[0]['CALENDAR_DATABASE_ID']).toBe('db-c')
    // 用户挑的 data source 一并落盘（选择器是 data source 粒度 —— 只写 database id
    // 会让 Python 侧回到盲取 data_sources[0]，多 data source 库上就是另一个数据源）。
    expect(patches[0]['EMAIL_DATA_SOURCE_ID']).toBe('ds-e1')
    expect(patches[0]['CALENDAR_DATA_SOURCE_ID']).toBe('ds-c')
    expect(patches[0]['NOTION_TOKEN']).toBe(TOKEN)
    expect(__test__.snapshot().hasActive).toBe(false)
  })
})

describe('removeConnection', () => {
  test('七键全清（null = 注释掉），无「保留 token」路径', () => {
    const r = removeConnection()
    expect(r).toEqual({ ok: true })
    expect(patches).toHaveLength(1)
    // 🔴 DATA_SOURCE 两键必须一起清：留着会在换手填配置后指向上一个 workspace 的数据源。
    expect(patches[0]).toEqual({
      NOTION_TOKEN: null,
      EMAIL_DATABASE_ID: null,
      CALENDAR_DATABASE_ID: null,
      EMAIL_DATA_SOURCE_ID: null,
      CALENDAR_DATA_SOURCE_ID: null,
      NOTION_WORKSPACE_ID: null,
      NOTION_WORKSPACE_NAME: null
    })
    expectAllKeysManaged(patches[0])
  })
})

describe('库发现纯函数（fixture = owner 真实模板结构）', () => {
  test('模板路径：翻页 + toggle 下钻 + linked view 404 跳过 + child_page 不下钻，三真库全收', async () => {
    baseDeps({ fetchImpl: routedFetch(templateRoutes()) })
    const cands = await discoverFromTemplate(TOKEN, 'tpl-1')
    // 三个真库；两个 linked view（lv-1/lv-2）404 被静默跳过；cp-1（child_page）
    // 没有 children 路由 —— 误下钻会 unrouted 抛错，此断言通过即证明没下钻。
    expect(cands).toHaveLength(3)
    const email = cands.find((c) => c.role === 'email')!
    expect(email.valid).toBe(true)
    expect(email.databaseId).toBe('db-email')
    expect(email.id).toBe('ds-email')
    const cal = cands.find((c) => c.role === 'calendar')!
    expect(cal.valid).toBe(true)
    expect(cal.databaseId).toBe('db-cal')
    // 第三真库（Daily Digests）两个签名都不命中 → unknown，自然落选。
    const digest = cands.find((c) => c.id === 'ds-digest')!
    expect(digest.role).toBe('unknown')
    expect(digest.valid).toBe(false)
  })

  test('容器递归有深度上限（第 6 层容器不再下钻）', async () => {
    const routes: Route[] = []
    const toggleAt = (id: string, childId: string): Route => ({
      match: (u) => u.pathname === `/v1/blocks/${id}/children`,
      reply: () => ({
        json: {
          object: 'list',
          results: [
            { object: 'block', id: childId, type: 'toggle', has_children: true, toggle: {} }
          ],
          has_more: false,
          next_cursor: null
        }
      })
    })
    routes.push(
      {
        // 根页面只有一个 toggle 链的入口（覆盖原 tpl-1 首页路由）。
        match: (u) => u.pathname === '/v1/blocks/tpl-deep/children',
        reply: () => ({
          json: {
            object: 'list',
            results: [
              { object: 'block', id: 'tg-d1', type: 'toggle', has_children: true, toggle: {} }
            ],
            has_more: false,
            next_cursor: null
          }
        })
      },
      toggleAt('tg-d1', 'tg-d2'),
      toggleAt('tg-d2', 'tg-d3'),
      toggleAt('tg-d3', 'tg-d4'),
      toggleAt('tg-d4', 'tg-d5'),
      toggleAt('tg-d5', 'tg-d6')
      // tg-d6 深度 6 > 上限 5：children 路由有意不存在 —— 误下钻会 unrouted 抛错。
    )
    baseDeps({ fetchImpl: routedFetch(routes) })
    const cands = await discoverFromTemplate(TOKEN, 'tpl-deep')
    expect(cands).toEqual([])
  })

  test('缺字段的 data source → valid=false + 具体缺失清单', async () => {
    const routes = templateRoutes()
    // 把 ds-email 的 properties 挖掉两个字段。
    const broken = propsFor('email')
    delete (broken as Record<string, unknown>)['Message ID']
    delete (broken as Record<string, unknown>)['Mailbox']
    routes[
      routes.findIndex((r) => r.match(new URL('https://api.notion.com/v1/data_sources/ds-email')))
    ] = {
      match: (u) => u.pathname === '/v1/data_sources/ds-email',
      reply: () => ({
        json: {
          object: 'data_source',
          id: 'ds-email',
          parent: { type: 'database_id', database_id: 'db-email' },
          properties: broken
        }
      })
    }
    baseDeps({ fetchImpl: routedFetch(routes) })
    const cands = await discoverFromTemplate(TOKEN, 'tpl-1')
    const email = cands.find((c) => c.id === 'ds-email')!
    expect(email.role).toBe('unknown') // 签名字段 Message ID 没了 → 识别不出角色
    expect(email.valid).toBe(false)
  })

  test('search 路径：data_source（inline properties）与 database 两种形态都吃，去重', async () => {
    baseDeps({ fetchImpl: routedFetch(searchRoutes()) })
    const cands = await discoverFromSearch(TOKEN)
    expect(cands.map((c) => c.id).sort()).toEqual(['ds-c', 'ds-e1', 'ds-e2'])
    expect(cands.find((c) => c.id === 'ds-e1')!.databaseId).toBe('db-e1')
    expect(cands.find((c) => c.id === 'ds-c')!.role).toBe('calendar')
  })
})
